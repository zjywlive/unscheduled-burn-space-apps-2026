// Major named lunar features for the whole-Moon map labels. Names and centre coordinates from the IAU /
// USGS Gazetteer of Planetary Nomenclature (planetarynames.wr.usgs.gov), accessed 2026-11-14; each value is the one
// each feature's own page shows by default (control network "LOLA 2011"). The pages give coordinates as
// "Planetographic, +East, -180 - 180"; the Moon's IAU reference surface is a sphere, so that latitude is also the
// planetocentric latitude. Longitudes here are east 0–360° (page value + 360 where it was negative); diameter in km
// as listed there. Rounded to 0.01°, which is how the pages list them.
// type: 'mare' / 'oceanus' follow the gazetteer feature type. The gazetteer types every other entry here as
// "Crater, craters"; those listed at 300 km or more (the usual lower bound for a lunar impact basin) are tagged
// 'basin', the rest 'crater'. South Pole-Aitken basin has no gazetteer entry, so it is not included.
export const GAZETTEER_SOURCE = 'IAU/USGS Gazetteer of Planetary Nomenclature, https://planetarynames.wr.usgs.gov (accessed 2026-11-14)';
export const GAZETTEER = Object.freeze([
  { name: 'Mare Imbrium', type: 'mare', latDeg: 34.72, lonDeg: 345.09, diameterKm: 1145.53, url: 'https://planetarynames.wr.usgs.gov/Feature/3678' },
  { name: 'Mare Serenitatis', type: 'mare', latDeg: 27.29, lonDeg: 18.36, diameterKm: 674.28, url: 'https://planetarynames.wr.usgs.gov/Feature/3686' },
  { name: 'Mare Tranquillitatis', type: 'mare', latDeg: 8.35, lonDeg: 30.83, diameterKm: 875.75, url: 'https://planetarynames.wr.usgs.gov/Feature/3691' },
  { name: 'Mare Crisium', type: 'mare', latDeg: 16.18, lonDeg: 59.1, diameterKm: 555.92, url: 'https://planetarynames.wr.usgs.gov/Feature/3671' },
  { name: 'Mare Fecunditatis', type: 'mare', latDeg: -7.83, lonDeg: 53.67, diameterKm: 840.35, url: 'https://planetarynames.wr.usgs.gov/Feature/3673' },
  { name: 'Mare Nectaris', type: 'mare', latDeg: -15.19, lonDeg: 34.6, diameterKm: 339.39, url: 'https://planetarynames.wr.usgs.gov/Feature/3683' },
  { name: 'Mare Nubium', type: 'mare', latDeg: -20.59, lonDeg: 342.71, diameterKm: 714.5, url: 'https://planetarynames.wr.usgs.gov/Feature/3684' },
  { name: 'Mare Humorum', type: 'mare', latDeg: -24.48, lonDeg: 321.43, diameterKm: 419.67, url: 'https://planetarynames.wr.usgs.gov/Feature/3677' },
  { name: 'Mare Frigoris', type: 'mare', latDeg: 57.59, lonDeg: 359.99, diameterKm: 1446.41, url: 'https://planetarynames.wr.usgs.gov/Feature/3674' },
  { name: 'Oceanus Procellarum', type: 'oceanus', latDeg: 20.67, lonDeg: 303.32, diameterKm: 2592.24, url: 'https://planetarynames.wr.usgs.gov/Feature/4395' },
  { name: 'Mare Orientale', type: 'mare', latDeg: -19.87, lonDeg: 265.33, diameterKm: 294.16, url: 'https://planetarynames.wr.usgs.gov/Feature/3685' },
  { name: 'Mare Moscoviense', type: 'mare', latDeg: 27.28, lonDeg: 148.12, diameterKm: 275.57, url: 'https://planetarynames.wr.usgs.gov/Feature/3682' },
  { name: 'Mare Australe', type: 'mare', latDeg: -47.77, lonDeg: 91.99, diameterKm: 996.84, url: 'https://planetarynames.wr.usgs.gov/Feature/3665' },
  { name: 'Mare Smythii', type: 'mare', latDeg: -1.71, lonDeg: 87.05, diameterKm: 373.97, url: 'https://planetarynames.wr.usgs.gov/Feature/3689' },
  { name: 'Mare Marginis', type: 'mare', latDeg: 12.7, lonDeg: 86.52, diameterKm: 357.63, url: 'https://planetarynames.wr.usgs.gov/Feature/3681' },
  { name: 'Tycho', type: 'crater', latDeg: -43.3, lonDeg: 348.78, diameterKm: 85.29, url: 'https://planetarynames.wr.usgs.gov/Feature/6163' },
  { name: 'Copernicus', type: 'crater', latDeg: 9.62, lonDeg: 339.92, diameterKm: 96.07, url: 'https://planetarynames.wr.usgs.gov/Feature/1296' },
  { name: 'Kepler', type: 'crater', latDeg: 8.12, lonDeg: 321.99, diameterKm: 29.49, url: 'https://planetarynames.wr.usgs.gov/Feature/2990' },
  { name: 'Aristarchus', type: 'crater', latDeg: 23.73, lonDeg: 312.51, diameterKm: 39.99, url: 'https://planetarynames.wr.usgs.gov/Feature/380' },
  { name: 'Plato', type: 'crater', latDeg: 51.62, lonDeg: 350.62, diameterKm: 100.68, url: 'https://planetarynames.wr.usgs.gov/Feature/4757' },
  { name: 'Clavius', type: 'crater', latDeg: -58.62, lonDeg: 345.27, diameterKm: 230.77, url: 'https://planetarynames.wr.usgs.gov/Feature/1236' },
  { name: 'Grimaldi', type: 'crater', latDeg: -5.38, lonDeg: 291.64, diameterKm: 235, url: 'https://planetarynames.wr.usgs.gov/Feature/2252' },
  { name: 'Langrenus', type: 'crater', latDeg: -8.86, lonDeg: 61.04, diameterKm: 131.98, url: 'https://planetarynames.wr.usgs.gov/Feature/3273' },
  { name: 'Petavius', type: 'crater', latDeg: -25.39, lonDeg: 60.78, diameterKm: 184.06, url: 'https://planetarynames.wr.usgs.gov/Feature/4668' },
  { name: 'Ptolemaeus', type: 'crater', latDeg: -9.16, lonDeg: 358.16, diameterKm: 153.67, url: 'https://planetarynames.wr.usgs.gov/Feature/4860' },
  { name: 'Theophilus', type: 'crater', latDeg: -11.45, lonDeg: 26.28, diameterKm: 98.59, url: 'https://planetarynames.wr.usgs.gov/Feature/5965' },
  { name: 'Shackleton', type: 'crater', latDeg: -89.67, lonDeg: 129.78, diameterKm: 20.92, url: 'https://planetarynames.wr.usgs.gov/Feature/5450' },
  { name: 'Von Kármán', type: 'crater', latDeg: -44.45, lonDeg: 176.25, diameterKm: 186.35, url: 'https://planetarynames.wr.usgs.gov/Feature/6440' },
  { name: 'Hertzsprung', type: 'basin', latDeg: 1.37, lonDeg: 231.34, diameterKm: 536.37, url: 'https://planetarynames.wr.usgs.gov/Feature/2482' },
  { name: 'Korolev', type: 'basin', latDeg: -4.19, lonDeg: 202.59, diameterKm: 423.41, url: 'https://planetarynames.wr.usgs.gov/Feature/3090' },
  { name: 'Apollo', type: 'basin', latDeg: -35.69, lonDeg: 208.52, diameterKm: 524.23, url: 'https://planetarynames.wr.usgs.gov/Feature/326' },
  { name: 'Schrödinger', type: 'basin', latDeg: -74.73, lonDeg: 132.93, diameterKm: 316.39, url: 'https://planetarynames.wr.usgs.gov/Feature/5381' },
]);
