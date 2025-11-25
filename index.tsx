import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import toGeoJSON from '@mapbox/togeojson';
import JSZip from 'jszip';
import * as GeoTIFF from 'geotiff';
import chroma from 'chroma-js';

// --- Constants & Config ---

const TILE_ZOOM = 12; 
const TILE_SIZE = 512; 
const AWS_TILE_URL = (x, y, z) => `https://s3.amazonaws.com/elevation-tiles-prod/geotiff/${z}/${x}/${y}.tif`;

// Slope Classes (10 classes)
const SLOPE_RANGES = [
  { max: 2, label: '0° - 2°', color: '#2ecc71' },
  { max: 5, label: '2° - 5°', color: '#58d68d' },
  { max: 9, label: '5° - 9°', color: '#82e0aa' },
  { max: 15, label: '9° - 15°', color: '#f7dc6f' },
  { max: 20, label: '15° - 20°', color: '#f1c40f' },
  { max: 25, label: '20° - 25°', color: '#f39c12' },
  { max: 30, label: '25° - 30°', color: '#e67e22' },
  { max: 35, label: '30° - 35°', color: '#d35400' },
  { max: 45, label: '35° - 45°', color: '#c0392b' },
  { max: 999, label: '> 45°', color: '#922b21' },
];

// --- Helper Functions ---

const lng2tile = (lon, zoom) => (Math.floor((lon + 180) / 360 * Math.pow(2, zoom)));
const lat2tile = (lat, zoom) => (Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)));
const tile2lng = (x, z) => (x / Math.pow(2, z) * 360 - 180);
const tile2lat = (y, z) => {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return (180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
};

const generateKML = (features) => {
  let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>User Drawn Shapes</name>
`;

  features.forEach((f, i) => {
    kml += `    <Placemark>
      <name>Shape ${i + 1}</name>
      <styleUrl>#polyStyle</styleUrl>
`;
    
    if (f.geometry.type === 'Point') {
        const [lng, lat] = f.geometry.coordinates;
        kml += `      <Point><coordinates>${lng},${lat}</coordinates></Point>\n`;
    } else if (f.geometry.type === 'LineString') {
        const coords = f.geometry.coordinates.map(c => `${c[0]},${c[1]}`).join(' ');
        kml += `      <LineString><coordinates>${coords}</coordinates></LineString>\n`;
    } else if (f.geometry.type === 'Polygon') {
        kml += `      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>
`;
        f.geometry.coordinates[0].forEach(c => {
            kml += `              ${c[0]},${c[1]}\n`;
        });
        kml += `            </coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>\n`;
    }
    
    kml += `    </Placemark>\n`;
  });

  kml += `  </Document>
</kml>`;
  return kml;
};

// --- Icons ---

const LogoIcon = () => (
  <svg width="40" height="40" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M50 5C27.9 5 10 22.9 10 45C10 75 50 95 50 95C50 95 90 75 90 45C90 22.9 72.1 5 50 5ZM50 82C34 72 20 58 20 45C20 28.4 33.4 15 50 15C66.6 15 80 28.4 80 45C80 58 66 72 50 82Z" fill="#16a34a"/>
    <path d="M40 30H45V40H55V30H60V50H55V45H45V60H40V30Z" fill="#a3e635"/> 
    <path d="M45 45L75 35L45 25V45Z" fill="#bef264"/>
    <circle cx="50" cy="45" r="30" stroke="#16a34a" strokeWidth="5"/>
  </svg>
);

const MenuIcon = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
);

const CloseIcon = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
);

const DrawIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg>
);

const PolyIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>
);

const LineIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="20" y2="3"></line><polyline points="4 21 9 21 9 16"></polyline><polyline points="15 8 20 8 20 3"></polyline></svg>
);

const PointIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
);

const DownloadIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
);

// --- Components ---

const App = () => {
  const [status, setStatus] = useState('idle'); // idle, processing, done, error
  const [statusMessage, setStatusMessage] = useState('');
  const [kmlLayer, setKmlLayer] = useState(null);
  const [resultImage, setResultImage] = useState(null);
  const [geoData, setGeoData] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  
  // Drawing States
  const [drawMode, setDrawMode] = useState(null); // 'polygon', 'line', 'point', null
  const [showDrawMenu, setShowDrawMenu] = useState(false);
  const [drawnFeatures, setDrawnFeatures] = useState([]); // GeoJSON features
  const [tempPoints, setTempPoints] = useState([]); // Points for current shape being drawn
  const [mousePos, setMousePos] = useState(null); // For rubberbanding
  
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const fileInputRef = useRef(null);
  const drawingLayerRef = useRef(null);
  const previewLayerRef = useRef(null);

  // Responsive Check
  useEffect(() => {
    const checkMobile = () => {
        setIsMobile(window.innerWidth <= 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Initialize Map
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    const map = L.map(mapRef.current, { zoomControl: false }).setView([0, 0], 2);
    
    // Add standard Zoom control at top-left
    L.control.zoom({ position: 'topleft' }).addTo(map);

    // Switch to Satellite Map (Esri World Imagery)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri',
      maxZoom: 19
    }).addTo(map);

    L.tileLayer('https://stamen-tiles-{s}.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      minZoom: 0,
      maxZoom: 20,
      ext: 'png',
      opacity: 0.75
    }).addTo(map);

    // Drawing Layer Group
    const drawGroup = L.layerGroup().addTo(map);
    drawingLayerRef.current = drawGroup;

    // Preview Layer (for current drawing)
    const previewGroup = L.layerGroup().addTo(map);
    previewLayerRef.current = previewGroup;

    mapInstanceRef.current = map;
    
    setTimeout(() => { map.invalidateSize(); }, 200);

    // Map Event Listeners for Drawing
    map.on('click', (e) => {
        handleMapClick(e.latlng);
    });

    map.on('mousemove', (e) => {
        setMousePos(e.latlng);
    });

    map.on('contextmenu', () => {
        // Right click to cancel drawing or finish line
        finishDrawing();
    });

    // Double click to finish polygon/line
    map.on('dblclick', (e) => {
        finishDrawing(true);
        L.DomEvent.stop(e);
    });

  }, []);

  // Update cursor based on draw mode
  useEffect(() => {
      if(!mapRef.current) return;
      if (drawMode) {
          mapRef.current.classList.add('drawing-cursor');
      } else {
          mapRef.current.classList.remove('drawing-cursor');
      }
  }, [drawMode]);

  // Drawing Logic: Handle Map Click
  const handleMapClick = (latlng) => {
      // Accessing state via Refs inside event listener would be ideal, 
      // but since we rebuild the listener only on mount, we rely on the closure
      // However, React state (drawMode) inside Leaflet event listener might be stale 
      // if not careful. But 'drawMode' is a dependency of 'handleMapClick' 
      // if we were using useCallback.
      // 
      // Since map.on is in useEffect[], we need to use a Ref to track active DrawMode
      // OR re-bind events.
      //
      // BETTER APPROACH: Use a ref for currentDrawMode to avoid stale state in the event listener
  };
  
  // FIX: Use Ref to track draw mode for the Event Listener
  const drawModeRef = useRef(drawMode);
  const tempPointsRef = useRef(tempPoints);

  useEffect(() => {
      drawModeRef.current = drawMode;
      tempPointsRef.current = tempPoints;
  }, [drawMode, tempPoints]);

  useEffect(() => {
    // Re-bind click listener to ensure it has access to fresh state via Refs? 
    // Actually, simply using Refs inside the stable handler is better.
    if (!mapInstanceRef.current) return;

    const map = mapInstanceRef.current;
    
    const onClick = (e) => {
        const mode = drawModeRef.current;
        if (!mode) return;

        if (mode === 'point') {
            const newFeature = {
                type: "Feature",
                properties: {},
                geometry: {
                    type: "Point",
                    coordinates: [e.latlng.lng, e.latlng.lat]
                }
            };
            addDrawnFeature(newFeature);
            setDrawMode(null);
            return;
        }
        setTempPoints(prev => [...prev, e.latlng]);
    };

    map.off('click');
    map.on('click', onClick);

    return () => {
        map.off('click', onClick);
    };
  }, []); // Bind once, use Refs for state

  const finishDrawing = (isDblClick = false) => {
      const mode = drawModeRef.current;
      const points = [...tempPointsRef.current];

      if (!mode || points.length === 0) {
          setDrawMode(null);
          setTempPoints([]);
          return;
      }

      let geometry = null;
      // Copy points to break reference
      const finalPoints = points.map(p => ({...p}));

      if (mode === 'polygon') {
          if (finalPoints.length < 3) {
            alert("Polygon needs at least 3 points.");
            setDrawMode(null);
            setTempPoints([]);
            return;
          }
          // Close the ring
          finalPoints.push(finalPoints[0]); 
          const coords = finalPoints.map(p => [p.lng, p.lat]);
          geometry = {
              type: "Polygon",
              coordinates: [coords]
          };
      } else if (mode === 'line') {
          if (finalPoints.length < 2) {
            setDrawMode(null);
            setTempPoints([]);
            return;
          }
          const coords = finalPoints.map(p => [p.lng, p.lat]);
          geometry = {
              type: "LineString",
              coordinates: coords
          };
      }

      if (geometry) {
          const newFeature = {
              type: "Feature",
              properties: {},
              geometry: geometry
          };
          addDrawnFeature(newFeature);

          // If it's a Polygon, Trigger Slope Analysis
          if (mode === 'polygon') {
              triggerAnalysisFromDraw(newFeature);
          }
      }

      setDrawMode(null);
      setTempPoints([]);
  };

  const addDrawnFeature = (feature) => {
      setDrawnFeatures(prev => [...prev, feature]);
      
      // Add to Leaflet Layer
      L.geoJSON(feature, {
          style: { 
            color: '#ffeb3b', 
            weight: 3, 
            opacity: 1, 
            fillOpacity: 0.2,
            className: 'pass-through' // KEY FIX: CSS pointer-events: none
          },
          pointToLayer: (feature, latlng) => {
              return L.circleMarker(latlng, { 
                radius: 6, 
                fillColor: "#ffeb3b", 
                color: "#000", 
                weight: 1, 
                fillOpacity: 0.8,
                className: 'pass-through' // KEY FIX
              });
          },
          interactive: false 
      }).addTo(drawingLayerRef.current);
  };

  // Render Rubberband line
  useEffect(() => {
      if (!mapInstanceRef.current || !previewLayerRef.current) return;
      previewLayerRef.current.clearLayers();

      if (!drawMode || tempPoints.length === 0) return;

      const points = [...tempPoints];
      if (mousePos) points.push(mousePos);

      const options = { 
        color: '#ffeb3b', 
        weight: 2, 
        dashArray: '5, 5', 
        interactive: false,
        className: 'pass-through' // KEY FIX
      };

      if (drawMode === 'polygon') {
          L.polygon(points, { ...options, fill: false }).addTo(previewLayerRef.current);
          tempPoints.forEach(p => {
              L.circleMarker(p, { radius: 4, color: '#ffeb3b', fill: true, interactive: false, className: 'pass-through' }).addTo(previewLayerRef.current);
          });
      } else if (drawMode === 'line') {
          L.polyline(points, options).addTo(previewLayerRef.current);
          tempPoints.forEach(p => {
              L.circleMarker(p, { radius: 4, color: '#ffeb3b', fill: true, interactive: false, className: 'pass-through' }).addTo(previewLayerRef.current);
          });
      }

  }, [tempPoints, mousePos, drawMode]);

  const triggerAnalysisFromDraw = (feature) => {
      // Clear previous layers
      if (kmlLayer) mapInstanceRef.current.removeLayer(kmlLayer);
      if (resultImage) mapInstanceRef.current.removeLayer(resultImage);
      setResultImage(null);
      setGeoData(null);
      
      const geoJson = { type: "FeatureCollection", features: [feature] };
      // Use temp layer to get bounds then remove immediately
      const layer = L.geoJSON(geoJson).addTo(mapInstanceRef.current); 
      const bounds = layer.getBounds();
      mapInstanceRef.current.removeLayer(layer); 

      setKmlLayer(null); 
      setStatus('processing');
      performTerrainAnalysis(bounds, geoJson);
  };

  // Invalidate map size when sidebar toggles
  useEffect(() => {
      if (mapInstanceRef.current) {
          setTimeout(() => { mapInstanceRef.current.invalidateSize(); }, 300);
      }
  }, [isSidebarOpen]);

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Clear drawn items if uploading new KML
    drawingLayerRef.current.clearLayers();
    setDrawnFeatures([]);

    setStatus('processing');
    setStatusMessage('Parsing KML/KMZ...');
    
    if (kmlLayer) mapInstanceRef.current.removeLayer(kmlLayer);
    if (resultImage) mapInstanceRef.current.removeLayer(resultImage);
    setResultImage(null);
    setGeoData(null);

    try {
      const kmlText = await parseKmlFile(file);
      const rawGeoJson = parseKmlTextToGeoJson(kmlText);
      
      if (!rawGeoJson || !rawGeoJson.features) {
        throw new Error("Invalid KML data structure.");
      }

      const polygonFeatures = rawGeoJson.features.filter(f => 
        f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
      );

      if (polygonFeatures.length === 0) {
        throw new Error("No Polygon layer detected");
      }

      const geoJson = {
        type: "FeatureCollection",
        features: polygonFeatures
      };

      const layer = L.geoJSON(geoJson, {
        style: { 
            color: '#3498db', 
            weight: 2, 
            fillOpacity: 0.0, 
            opacity: 0.8,
            className: 'pass-through' // KEY FIX
        },
        interactive: false
      }).addTo(mapInstanceRef.current);
      
      const bounds = layer.getBounds();
      mapInstanceRef.current.fitBounds(bounds);
      setKmlLayer(layer);

      await performTerrainAnalysis(bounds, geoJson);

    } catch (err) {
      console.error(err);
      setStatus('error');
      setStatusMessage(`Error: ${err.message}`);
    }
  };

  const parseKmlFile = async (file) => {
    if (file.name.toLowerCase().endsWith('.kmz')) {
      const zip = await JSZip.loadAsync(file);
      const kmlFile = Object.keys(zip.files).find(n => n.endsWith('.kml'));
      if (!kmlFile) throw new Error("Invalid KMZ: No KML file found inside.");
      return await zip.file(kmlFile).async("string");
    } else {
      return await file.text();
    }
  };

  const parseKmlTextToGeoJson = (text) => {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const kmlParser = toGeoJSON.kml || toGeoJSON.default?.kml;
    if (!kmlParser) throw new Error("KML Parser not initialized correctly.");
    return kmlParser(xml);
  };

  const performTerrainAnalysis = async (leafletBounds, geoJson) => {
    setStatusMessage('Calculating tile coverage...');
    const bounds = {
      north: leafletBounds.getNorth(),
      south: leafletBounds.getSouth(),
      east: leafletBounds.getEast(),
      west: leafletBounds.getWest()
    };

    const xMin = lng2tile(bounds.west, TILE_ZOOM);
    const xMax = lng2tile(bounds.east, TILE_ZOOM);
    const yMin = lat2tile(bounds.north, TILE_ZOOM);
    const yMax = lat2tile(bounds.south, TILE_ZOOM);

    const tilesToFetch = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tilesToFetch.push({ x, y, z: TILE_ZOOM });
      }
    }

    setStatusMessage(`Fetching ${tilesToFetch.length} DEM tiles from AWS...`);
    
    const tileBuffers = await Promise.all(tilesToFetch.map(async (t) => {
      try {
        const response = await fetch(AWS_TILE_URL(t.x, t.y, t.z));
        if (!response.ok) throw new Error(`Failed to fetch tile ${t.x},${t.y}`);
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
        const image = await tiff.getImage();
        const rasters = await image.readRasters();
        return { ...t, data: rasters[0], width: image.getWidth(), height: image.getHeight() };
      } catch (e) {
        console.warn("Tile fetch failed", e);
        return null;
      }
    }));

    const validTiles = tileBuffers.filter(t => t !== null);
    if (validTiles.length === 0) throw new Error("Could not download any elevation data.");

    setStatusMessage('Stitching DEM mosaic...');
    
    const mosaicWidth = (xMax - xMin + 1) * TILE_SIZE;
    const mosaicHeight = (yMax - yMin + 1) * TILE_SIZE;
    const mosaicData = new Float32Array(mosaicWidth * mosaicHeight);

    validTiles.forEach(tile => {
      const offsetX = (tile.x - xMin) * TILE_SIZE;
      const offsetY = (tile.y - yMin) * TILE_SIZE;
      
      for (let r = 0; r < TILE_SIZE; r++) {
        for (let c = 0; c < TILE_SIZE; c++) {
            const val = tile.data[r * TILE_SIZE + c];
            mosaicData[(offsetY + r) * mosaicWidth + (offsetX + c)] = val;
        }
      }
    });

    setStatusMessage('Calculating Slope...');

    const mosaicNorth = tile2lat(yMin, TILE_ZOOM);
    const mosaicWest = tile2lng(xMin, TILE_ZOOM);
    const mosaicSouth = tile2lat(yMax + 1, TILE_ZOOM);
    const mosaicEast = tile2lng(xMax + 1, TILE_ZOOM);

    const degPerPixelX = (mosaicEast - mosaicWest) / mosaicWidth;
    const degPerPixelY = (mosaicNorth - mosaicSouth) / mosaicHeight;

    const slopeData = new Float32Array(mosaicData.length);
    const rgbaData = new Uint8Array(mosaicData.length * 4);

    const centerLat = (mosaicNorth + mosaicSouth) / 2;
    const metersPerLat = 111320;
    const metersPerLng = 111320 * Math.cos(centerLat * Math.PI / 180);

    const cellSizeX = degPerPixelX * metersPerLng;
    const cellSizeY = degPerPixelY * metersPerLat;

    for (let y = 1; y < mosaicHeight - 1; y++) {
      for (let x = 1; x < mosaicWidth - 1; x++) {
        const idx = y * mosaicWidth + x;
        
        const zN = mosaicData[(y - 1) * mosaicWidth + x];
        const zS = mosaicData[(y + 1) * mosaicWidth + x];
        const zE = mosaicData[y * mosaicWidth + (x + 1)];
        const zW = mosaicData[y * mosaicWidth + (x - 1)];

        if (zN < -10000 || zS < -10000 || zE < -10000 || zW < -10000) {
           slopeData[idx] = 0;
           continue;
        }

        const dzdx = (zE - zW) / (2 * cellSizeX);
        const dzdy = (zN - zS) / (2 * cellSizeY); 
        
        const riseRun = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
        const slopeRad = Math.atan(riseRun);
        const slopeDeg = slopeRad * (180 / Math.PI);

        slopeData[idx] = slopeDeg;

        let color = '#00000000';
        for (const range of SLOPE_RANGES) {
            if (slopeDeg <= range.max) {
                color = range.color;
                break;
            }
        }
        
        const [r, g, b] = chroma(color).rgb();
        const alpha = 210; 

        rgbaData[idx * 4] = r;
        rgbaData[idx * 4 + 1] = g;
        rgbaData[idx * 4 + 2] = b;
        rgbaData[idx * 4 + 3] = alpha;
      }
    }

    setStatusMessage('Clipping to Geometry...');

    const canvas = document.createElement('canvas');
    canvas.width = mosaicWidth;
    canvas.height = mosaicHeight;
    const ctx = canvas.getContext('2d');
    const imageData = new ImageData(new Uint8ClampedArray(rgbaData), mosaicWidth, mosaicHeight);
    ctx.putImageData(imageData, 0, 0);

    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = '#000000';

    const lngToX = (lng) => (lng - mosaicWest) / (mosaicEast - mosaicWest) * mosaicWidth;
    const latToY = (lat) => (mosaicNorth - lat) / (mosaicNorth - mosaicSouth) * mosaicHeight;

    const drawRing = (coords) => {
        if (!coords || coords.length === 0) return;
        ctx.moveTo(lngToX(coords[0][0]), latToY(coords[0][1]));
        for (let i = 1; i < coords.length; i++) {
            ctx.lineTo(lngToX(coords[i][0]), latToY(coords[i][1]));
        }
        ctx.closePath();
    };

    ctx.beginPath();
    geoJson.features.forEach(feature => {
        const geometry = feature.geometry;
        if (!geometry) return;

        if (geometry.type === 'Polygon') {
            geometry.coordinates.forEach(ring => drawRing(ring));
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach(polygon => {
                polygon.forEach(ring => drawRing(ring));
            });
        }
    });
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    const clippedImageUrl = canvas.toDataURL();

    const imageBounds = [[mosaicNorth, mosaicWest], [mosaicSouth, mosaicEast]];
    const imgOverlay = L.imageOverlay(clippedImageUrl, imageBounds, {
        opacity: 0.8,
        interactive: false,
        className: 'pass-through' // KEY FIX
    }).addTo(mapInstanceRef.current);
    setResultImage(imgOverlay);
    
    setGeoData({
        width: mosaicWidth,
        height: mosaicHeight,
        north: mosaicNorth,
        west: mosaicWest,
        pixelW: degPerPixelX,
        pixelH: degPerPixelY,
        canvas: canvas, 
        rawSlope: slopeData
    });

    setStatus('done');
    setStatusMessage('Analysis Complete.');

    if (window.innerWidth <= 768) {
        setIsSidebarOpen(false);
    }
  };

  const handleDownload = async () => {
    if (!geoData) return;
    const zip = new JSZip();
    const blob = await new Promise(resolve => {
        geoData.canvas.toBlob(resolve, 'image/png');
    });
    
    zip.file("slope_analysis_clipped.tif", blob);

    const ulX = geoData.west + (geoData.pixelW / 2);
    const ulY = geoData.north - (geoData.pixelH / 2);
    
    const tfwContent = [
        geoData.pixelW.toFixed(12),
        0,
        0,
        (-geoData.pixelH).toFixed(12),
        ulX.toFixed(12),
        ulY.toFixed(12)
    ].join('\n');
    
    zip.file("slope_analysis_clipped.tfw", tfwContent);
    const prjContent = `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]`;
    zip.file("slope_analysis_clipped.prj", prjContent);

    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(content);
    link.download = "slope_analysis_output.zip";
    link.click();
  };

  const handleDownloadKml = () => {
      if (drawnFeatures.length === 0) return;
      
      const kmlString = generateKML(drawnFeatures);
      const blob = new Blob([kmlString], { type: "application/vnd.google-earth.kml+xml" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "user_drawn_shapes.kml";
      link.click();
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className={`sidebar ${isSidebarOpen ? 'open' : 'closed'}`}>
        <div className="header">
          <div className="brand">
            <LogoIcon />
            <h1>Slope Analysis Portal</h1>
          </div>
          {isMobile && (
              <button className="btn-close-sidebar" onClick={() => setIsSidebarOpen(false)}>
                  <CloseIcon />
                  <span style={{marginLeft: '5px'}}>View Map</span>
              </button>
          )}
          {!isMobile && <p>Extract DEM & Process Slope from KML</p>}
        </div>

        <div className="control-group">
          <label className="btn-upload">
            Select KML / KMZ
            <input 
                type="file" 
                accept=".kml,.kmz" 
                onChange={handleFileSelect} 
                ref={fileInputRef}
                style={{display: 'none'}}
            />
          </label>
        </div>

        <div className="status-panel">
            <div className={`status-indicator ${status}`}></div>
            <span>{status === 'idle' ? 'Ready' : statusMessage}</span>
        </div>

        {status === 'done' && (
            <button className="btn-download" onClick={handleDownload}>
                Download Clipped Raster
            </button>
        )}

        <div className="legend">
            <h3>Slope Classification</h3>
            {SLOPE_RANGES.map((range, i) => (
                <div key={i} className="legend-item">
                    <span className="color-box" style={{background: range.color}}></span>
                    <span>{range.label}</span>
                </div>
            ))}
        </div>
        
        <div className="footer">
            <p>Data Source: AWS Terrain Tiles</p>
            <p className="developer-credit">Developed by Krishna</p>
        </div>
      </div>

      {/* Map Area */}
      <div className="map-wrapper">
        <div id="map" ref={mapRef}></div>

        {/* Custom Drawing Toolbar */}
        <div className="custom-toolbar">
            <div className="toolbar-group">
                <button 
                    className={`tool-btn ${drawMode ? 'active' : ''}`}
                    title="Draw Tools"
                    onClick={() => setShowDrawMenu(!showDrawMenu)}
                >
                    <DrawIcon />
                </button>
                
                {showDrawMenu && (
                    <div className="sub-menu">
                        <button className={`tool-btn ${drawMode === 'polygon' ? 'active' : ''}`} onClick={() => { setDrawMode('polygon'); setShowDrawMenu(false); }} title="Draw Polygon"><PolyIcon /></button>
                        <button className={`tool-btn ${drawMode === 'line' ? 'active' : ''}`} onClick={() => { setDrawMode('line'); setShowDrawMenu(false); }} title="Draw Line"><LineIcon /></button>
                        <button className={`tool-btn ${drawMode === 'point' ? 'active' : ''}`} onClick={() => { setDrawMode('point'); setShowDrawMenu(false); }} title="Draw Point"><PointIcon /></button>
                    </div>
                )}
            </div>

            {drawnFeatures.length > 0 && (
                <button 
                    className="tool-btn download-kml-btn" 
                    onClick={handleDownloadKml}
                    title="Download Drawn KML"
                >
                    <DownloadIcon />
                </button>
            )}
        </div>
        
        {/* Mobile Sidebar Toggle */}
        {!isSidebarOpen && (
            <button className="btn-menu-toggle" onClick={() => setIsSidebarOpen(true)}>
                <MenuIcon />
            </button>
        )}

        {/* Helper Hint for Drawing */}
        {drawMode && (
            <div className="drawing-hint">
                {drawMode === 'polygon' ? 'Click to add points. Double-click to close.' :
                 drawMode === 'line' ? 'Click to add points. Double-click to finish.' :
                 'Click map to add a point.'}
                <button onClick={() => {setDrawMode(null); setTempPoints([]);}}>Cancel</button>
            </div>
        )}
      </div>

      <style>{`
        .app-container { display: flex; height: 100vh; width: 100vw; overflow: hidden; background: #222; position: relative; }
        .sidebar { 
          width: 340px; background: rgba(30, 41, 59, 0.95); backdrop-filter: blur(10px); 
          color: white; padding: 20px; display: flex; flex-direction: column; 
          box-shadow: 2px 0 10px rgba(0,0,0,0.5); z-index: 2000; border-right: 1px solid #334155; 
          transition: transform 0.3s ease-in-out;
        }
        .header { margin-bottom: 25px; border-bottom: 1px solid #475569; padding-bottom: 15px; }
        .header .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 5px; }
        .header h1 { font-size: 1.3rem; margin: 0; font-weight: 700; color: #f1f5f9; line-height: 1.2; }
        .header p { font-size: 0.85rem; color: #94a3b8; margin: 0; padding-left: 2px; }
        .control-group { margin-bottom: 20px; }
        .btn-upload { background: #3b82f6; color: white; padding: 12px 20px; border-radius: 6px; cursor: pointer; display: block; text-align: center; font-weight: 600; transition: background 0.2s; border: 1px solid #2563eb; }
        .btn-upload:hover { background: #2563eb; }
        .status-panel { background: #0f172a; padding: 15px; border-radius: 6px; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; font-size: 0.9rem; border: 1px solid #1e293b; }
        .status-indicator { width: 10px; height: 10px; border-radius: 50%; background: #64748b; flex-shrink: 0; }
        .status-indicator.processing { background: #eab308; animation: blink 1s infinite; }
        .status-indicator.done { background: #22c55e; }
        .status-indicator.error { background: #ef4444; }
        .btn-download { width: 100%; background: #16a34a; color: white; border: none; padding: 12px; border-radius: 6px; font-size: 1rem; cursor: pointer; font-weight: bold; margin-bottom: 20px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        .btn-download:hover { background: #15803d; }
        .legend { flex: 1; overflow-y: auto; padding-right: 5px; }
        .legend h3 { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 1px solid #475569; padding-bottom: 5px; color: #cbd5e1; }
        .legend-item { display: flex; align-items: center; margin-bottom: 8px; font-size: 0.85rem; color: #e2e8f0; }
        .color-box { width: 20px; height: 20px; margin-right: 12px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); }
        .footer { font-size: 0.75rem; color: #64748b; margin-top: 15px; text-align: center; border-top: 1px solid #334155; padding-top: 15px; }
        .developer-credit { margin-top: 5px; font-weight: 600; color: #94a3b8; }
        
        .map-wrapper { flex: 1; position: relative; width: 100%; height: 100%; }
        #map { width: 100%; height: 100%; z-index: 1; cursor: grab; }
        
        /* Force cursor style when drawing */
        .drawing-cursor { cursor: crosshair !important; }

        /* KEY FIX: Pass through pointer events for overlays to allow drawing on map */
        .pass-through {
            pointer-events: none !important;
        }

        /* Custom Toolbar */
        .custom-toolbar {
            position: absolute;
            top: 80px; /* Below standard Zoom control (approx 50px + margin) */
            left: 10px;
            z-index: 1000;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .toolbar-group { position: relative; }
        .tool-btn {
            width: 34px; height: 34px;
            background: white; border: 2px solid rgba(0,0,0,0.2);
            border-radius: 4px; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            color: #333;
            transition: all 0.2s;
        }
        .tool-btn:hover { background: #f4f4f4; }
        .tool-btn.active { background: #e0f2fe; color: #0284c7; border-color: #0284c7; }
        
        .sub-menu {
            position: absolute;
            left: 40px; top: 0;
            display: flex; gap: 5px;
            background: white; padding: 5px;
            border-radius: 4px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        }
        .download-kml-btn { color: #16a34a; border-color: #16a34a; }
        .download-kml-btn:hover { background: #dcfce7; }

        .drawing-hint {
            position: absolute;
            bottom: 30px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.7); color: white;
            padding: 8px 16px; border-radius: 20px;
            font-size: 0.9rem; pointer-events: auto;
            z-index: 1000;
            display: flex; gap: 10px; align-items: center;
        }
        .drawing-hint button {
            background: #ef4444; border: none; color: white;
            padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;
        }

        .btn-close-sidebar {
            background: rgba(255,255,255,0.1); border: none; color: white;
            padding: 8px 12px; border-radius: 4px; cursor: pointer;
            display: flex; align-items: center; margin-top: 10px; width: 100%;
            justify-content: center; font-weight: 600;
        }
        .btn-menu-toggle {
            position: absolute; top: 20px; left: 20px; z-index: 1500;
            background: #1e293b; color: white; border: 1px solid #475569;
            width: 44px; height: 44px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.3);
        }

        @media (max-width: 768px) {
            .app-container { flex-direction: column; }
            .sidebar { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border-right: none; }
            .sidebar.closed { transform: translateX(-100%); }
            .sidebar.open { transform: translateX(0); }
            .leaflet-top.leaflet-left { top: 70px; }
            .custom-toolbar { top: 150px; } /* Push down further on mobile */
        }
        .legend::-webkit-scrollbar { width: 6px; }
        .legend::-webkit-scrollbar-track { background: #0f172a; }
        .legend::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
        @keyframes blink { 50% { opacity: 0.5; } }
      `}</style>
    </div>
  );
};

const container = document.getElementById('root');
const root = createRoot(container);
root.render(<App />);