// Where every picture and number in the app comes from: one list for the Settings sheet's "Data and reset"
// rows and the Evidence sheet's sources table, so the two never disagree. The README's resource table is the
// full citation list (versions, URLs, licences); this is what a viewer of the page needs.
//
// shown: 'official' = a NASA product drawn as published, unchanged
//        'input'    = NASA data this tool calculates with
//        'ours'     = calculated by this tool from the inputs
//        'tools'    = used only by the MCP tools, not drawn in the page

export const SHOWN_LABEL = Object.freeze({
  official: 'NASA product, shown unchanged',
  input: 'NASA data, used in our calculations',
  ours: 'Calculated by this tool',
  tools: 'MCP tools only, not drawn on the map',
});

export const DATA_SOURCES = Object.freeze([
  { label: 'Sun and Earth', value: 'JPL Horizons API, DE441, 3 h steps, 1 Nov 2026 to 1 Jan 2029',
    shown: 'input', where: 'Sky dial, Sun & Earth panel, rise and set times, time left before sunset or Earthset' },
  { label: 'Terrain, whole Moon', value: 'NASA LRO LOLA global elevation (PDS): 7.6 km, 1.9 km and 474 m',
    shown: 'input', where: 'The 3D Moon, shading, contours, skylines north of 80°S' },
  { label: 'Terrain, south pole', value: 'LOLA polar elevation (PDS): 480, 240, 120, 40 and 20 m; 5–20 m patches at the landing sites',
    shown: 'input', where: 'Polar map, slope colours, route profile, rover tilt, descent view' },
  { label: 'Terrain, other patches', value: 'SLDEM2015 (LOLA with Kaguya Terrain Camera), 59 m patches',
    shown: 'input', where: 'Where to land, lander terrain away from the poles (badge “SLDEM2015 patch”)' },
  { label: 'Skylines', value: 'Terrain horizon in 72 directions from the LOLA grids: 480 m rays at a point, 2 km and 1 km grids for the map',
    shown: 'ours', where: 'The terrain edge in the sky dial; every “above the skyline” test' },
  { label: 'Sunlight and Earth view', value: 'Horizons positions tested against our skylines, hour by hour over the stay',
    shown: 'ours', where: 'Heat modes Sunlit, Earth in view, Both in view, Change, Suitability; landing windows, energy, comms' },
  { label: 'Shadowed regions', value: 'NASA permanently shadowed regions map, Mazarico et al. 2011, 2016 update, 120 m',
    shown: 'official', where: 'Layers → Permanently shadowed regions; the point card' },
  { label: 'Long-term light', value: 'NASA 18.6-year Sun and Earth visibility averages, Mazarico et al. 2011, 2016 update',
    shown: 'official', where: 'The point card, next to our hours for this stay' },
  { label: 'Lunar gravity', value: 'GRAIL GRGM900C (Lemoine et al. 2014): J2 and C22',
    shown: 'input', where: 'Lander trajectory in Execute' },
  { label: 'Feature names', value: 'IAU/USGS Gazetteer of Planetary Nomenclature',
    shown: 'input', where: 'Names on the lander map; the crater floors checked below' },
  { label: 'Possible ice', value: 'Diviner ice-stability depth and maximum temperature, Schorghofer & Williams 2020, 240 m',
    shown: 'tools', where: 'Site search in the MCP server; thermal modelling, not a detection' },
]);
