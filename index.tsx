import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import toGeoJSON from '@mapbox/togeojson';
import JSZip from 'jszip';
import * as GeoTIFF from 'geotiff';
import chroma from 'chroma-js';

// --- Constants & Config ---

const TILE_ZOOM = 12; // Level 12 is approx 30m resolution at equator, good for general analysis
const TILE_SIZE = 512; // AWS terrain tiles are 512x512
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
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="3" y1="12" x2="21" y2="12"></line>
        <line x1="3" y1="6" x2="21" y2="6"></line>
        <line x1="3" y1="18" x2="21" y2="18"></line>
    </svg>
);

const CloseIcon = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
    </svg>
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
  
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const fileInputRef = useRef(null);

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

    const map = L.map(mapRef.current).setView([0, 0], 2);
    
    // Switch to Satellite Map (Esri World Imagery)
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
      maxZoom: 19
    }).addTo(map);

    // Optional: Add labels layer
    L.tileLayer('https://stamen-tiles-{s}.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      minZoom: 0,
      maxZoom: 20,
      ext: 'png',
      opacity: 0.75
    }).addTo(map);

    mapInstanceRef.current = map;
    
    // Fix map size when resizing or toggling sidebar
    setTimeout(() => { map.invalidateSize(); }, 200);
  }, []);

  // Invalidate map size when sidebar toggles
  useEffect(() => {
      if (mapInstanceRef.current) {
          setTimeout(() => { mapInstanceRef.current.invalidateSize(); }, 300);
      }
  }, [isSidebarOpen]);

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStatus('processing');
    setStatusMessage('Parsing KML/KMZ...');
    
    // Reset previous
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

      // Filter for Polygons only
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

      // Display KML on Map
      const layer = L.geoJSON(geoJson, {
        style: { color: '#3498db', weight: 2, fillOpacity: 0.0, opacity: 0.8 }
      }).addTo(mapInstanceRef.current);
      
      const bounds = layer.getBounds();
      mapInstanceRef.current.fitBounds(bounds);
      setKmlLayer(layer);

      // Start Analysis
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
    // Ensure we access the correct function from the import depending on how it's bundled
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

    // Calculate Tile Range
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
    
    // Fetch Tiles
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
    
    // Create Mosaic
    const mosaicWidth = (xMax - xMin + 1) * TILE_SIZE;
    const mosaicHeight = (yMax - yMin + 1) * TILE_SIZE;
    const mosaicData = new Float32Array(mosaicWidth * mosaicHeight);

    // Fill Mosaic
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

    // Geospatial bounds of the mosaic (Tile Grid Bounds)
    // IMPORTANT: Use tile bounds, not KML bounds, for accurate pixel mapping
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
        const alpha = 210; // Slightly more opacity for satellite background

        rgbaData[idx * 4] = r;
        rgbaData[idx * 4 + 1] = g;
        rgbaData[idx * 4 + 2] = b;
        rgbaData[idx * 4 + 3] = alpha;
      }
    }

    setStatusMessage('Clipping to KML Geometry...');

    // 1. Create Base Canvas with Slope Data
    const canvas = document.createElement('canvas');
    canvas.width = mosaicWidth;
    canvas.height = mosaicHeight;
    const ctx = canvas.getContext('2d');
    const imageData = new ImageData(new Uint8ClampedArray(rgbaData), mosaicWidth, mosaicHeight);
    ctx.putImageData(imageData, 0, 0);

    // 2. Clipping Logic (Masking)
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = '#000000'; // Color doesn't matter for destination-in, only alpha

    // Coordinate conversion functions for Canvas drawing
    // Map Lat/Lng to Pixel X/Y relative to the Mosaic Top-Left
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
    
    // Reset Composite Op
    ctx.globalCompositeOperation = 'source-over';

    // 3. Generate Display and Export Data
    const clippedImageUrl = canvas.toDataURL();

    // Add Image Overlay to Map
    const imageBounds = [[mosaicNorth, mosaicWest], [mosaicSouth, mosaicEast]];
    const imgOverlay = L.imageOverlay(clippedImageUrl, imageBounds).addTo(mapInstanceRef.current);
    setResultImage(imgOverlay);
    
    // Save data for export
    setGeoData({
        width: mosaicWidth,
        height: mosaicHeight,
        north: mosaicNorth,
        west: mosaicWest,
        pixelW: degPerPixelX,
        pixelH: degPerPixelY,
        canvas: canvas, // This canvas is now clipped
        rawSlope: slopeData
    });

    setStatus('done');
    setStatusMessage('Analysis Complete. Ready to download.');

    // Auto-hide sidebar on mobile after success
    if (window.innerWidth <= 768) {
        setIsSidebarOpen(false);
    }
  };

  const handleDownload = async () => {
    if (!geoData) return;
    
    const zip = new JSZip();

    // 1. Raster Image (Clipped)
    const blob = await new Promise(resolve => {
        geoData.canvas.toBlob(resolve, 'image/png');
    });
    
    zip.file("slope_analysis_clipped.tif", blob);

    // 2. World File (.tfw)
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

    // 3. Projection File (.prj) for WGS84
    const prjContent = `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]`;
    zip.file("slope_analysis_clipped.prj", prjContent);

    // Generate Zip
    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(content);
    link.download = "slope_analysis_output.zip";
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
        
        {/* Mobile Sidebar Toggle (Floating Button) */}
        {!isSidebarOpen && (
            <button className="btn-menu-toggle" onClick={() => setIsSidebarOpen(true)}>
                <MenuIcon />
            </button>
        )}
      </div>

      <style>{`
        .app-container { display: flex; height: 100vh; width: 100vw; overflow: hidden; background: #222; position: relative; }
        
        .sidebar { 
          width: 340px; 
          background: rgba(30, 41, 59, 0.95); 
          backdrop-filter: blur(10px); 
          color: white; 
          padding: 20px; 
          display: flex; 
          flex-direction: column; 
          box-shadow: 2px 0 10px rgba(0,0,0,0.5); 
          z-index: 2000; 
          border-right: 1px solid #334155; 
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
        #map { width: 100%; height: 100%; z-index: 1; }

        /* Mobile specific styles */
        .btn-close-sidebar {
            background: rgba(255,255,255,0.1);
            border: none;
            color: white;
            padding: 8px 12px;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            margin-top: 10px;
            width: 100%;
            justify-content: center;
            font-weight: 600;
        }

        .btn-menu-toggle {
            position: absolute;
            top: 20px;
            left: 20px;
            z-index: 1500;
            background: #1e293b;
            color: white;
            border: 1px solid #475569;
            width: 44px;
            height: 44px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3);
        }

        /* Responsive Layout */
        @media (max-width: 768px) {
            .app-container {
                flex-direction: column;
            }
            
            .sidebar {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                box-sizing: border-box;
                border-right: none;
            }

            .sidebar.closed {
                transform: translateX(-100%);
            }
            
            .sidebar.open {
                transform: translateX(0);
            }

            .header h1 { font-size: 1.1rem; }
            
            /* Hide Leaflet Controls if they are under the menu button */
            .leaflet-top.leaflet-left {
                top: 70px; /* Push zoom controls down */
            }
        }

        /* Custom Scrollbar */
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