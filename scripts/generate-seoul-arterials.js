const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const readme = fs.readFileSync(path.join(root, "readme.md"), "utf8");
const raw = JSON.parse(fs.readFileSync("/tmp/seoul-arterials-osm-raw.json", "utf8"));
const aliases = JSON.parse(fs.readFileSync("/tmp/seoul-arterials-osm-aliases.json", "utf8"));
const sapyeong = JSON.parse(fs.readFileSync("/tmp/nominatim-sapyeong-50.json", "utf8"));
const yeouidaero = JSON.parse(fs.readFileSync("/tmp/yeouidaero-nominatim.json", "utf8"));
const naverOnly = new Map([
  ["가양대교", JSON.parse(fs.readFileSync("/tmp/audit-road-60001.json", "utf8"))],
  ["한강대교", JSON.parse(fs.readFileSync("/tmp/audit-road-60032.json", "utf8"))],
]);

const names = readme.split("\n")
  .filter(line => /^- [ㄱ-ㅎ] :/.test(line))
  .flatMap(line => line.split(":").slice(1).join(":").split(","))
  .map(name => name.trim())
  .filter(Boolean);

if (names.length !== 97 || new Set(names).size !== 97) {
  throw new Error(`README arterial list must contain 97 unique names, got ${names.length}`);
}

const SEOUL_BOX = { minLon: 126.74, maxLon: 127.22, minLat: 37.40, maxLat: 37.73 };
const MIA_BOX = { minLon: 127.017, maxLon: 127.034, minLat: 37.594, maxLat: 37.6165 };
// Several common road names are also used by unrelated roads elsewhere in the
// broad Seoul-area query box. Keep only the cluster belonging to the listed
// Seoul arterial so those names do not produce stray lines on the map.
const ROAD_BOXES = new Map([
  ["시흥대로", { minLon: 126.88, maxLon: 126.94, minLat: 37.42, maxLat: 37.51 }],
  ["신촌로", { minLon: 126.90, maxLon: 126.98, minLat: 37.53, maxLat: 37.58 }],
  ["양화로", { minLon: 126.88, maxLon: 126.95, minLat: 37.52, maxLat: 37.58 }],
  ["현충로", { minLon: 126.94, maxLon: 127.00, minLat: 37.48, maxLat: 37.53 }],
  ["화랑로", { minLon: 127.00, maxLon: 127.13, minLat: 37.58, maxLat: 37.67 }],
]);
const MAIN_TYPES = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
  "residential", "construction",
]);
const DRIVABLE_TYPES = new Set([
  ...MAIN_TYPES, "motorway_link", "trunk_link", "primary_link", "secondary_link",
  "tertiary_link", "living_street",
]);

function inside([lon, lat], box) {
  return lon >= box.minLon && lon <= box.maxLon && lat >= box.minLat && lat <= box.maxLat;
}

function clippedRuns(points, box) {
  const runs = [];
  let run = [];
  points.forEach((point, index) => {
    const pointInside = inside(point, box);
    const previous = points[index - 1];
    const previousInside = previous && inside(previous, box);
    if (pointInside) {
      if (!previousInside && previous) run.push(previous);
      run.push(point);
      return;
    }
    if (previousInside) {
      run.push(point);
      if (run.length >= 2) runs.push(run);
      run = [];
    } else if (run.length >= 2) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length >= 2) runs.push(run);
  return runs;
}

function perpendicularDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const t = Math.max(0, Math.min(1,
    ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

function simplify(points, tolerance = .000018) {
  if (points.length <= 2) return points;
  let farthestDistance = 0;
  let farthestIndex = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], points[0], points.at(-1));
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthestIndex = index;
    }
  }
  if (farthestDistance <= tolerance) return [points[0], points.at(-1)];
  const left = simplify(points.slice(0, farthestIndex + 1), tolerance);
  const right = simplify(points.slice(farthestIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function roundPoint([lon, lat]) {
  return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
}

function elementComponents(elements, box = SEOUL_BOX) {
  const main = elements.filter(element => MAIN_TYPES.has(element.tags?.highway));
  const selected = main.length ? main : elements.filter(element => DRIVABLE_TYPES.has(element.tags?.highway));
  return selected.flatMap(element => {
    const points = (element.geometry || []).map(point => [point.lon, point.lat]);
    return clippedRuns(points, box).map(run => simplify(run).map(roundPoint));
  });
}

function featureComponents(features, box = SEOUL_BOX) {
  return features.flatMap(feature => {
    const geometry = feature.geojson;
    if (!geometry) return [];
    const lines = geometry.type === "LineString" ? [geometry.coordinates]
      : geometry.type === "MultiLineString" ? geometry.coordinates : [];
    return lines.flatMap(line => clippedRuns(line, box).map(run => simplify(run).map(roundPoint)));
  });
}

function naverComponents(response) {
  return (response.groups || []).flatMap(group => {
    const start = group.stPoint?.coordinates;
    const end = group.edPoint?.coordinates;
    return Array.isArray(start) && Array.isArray(end) ? [[roundPoint(start), roundPoint(end)]] : [];
  });
}

function uniqueComponents(components) {
  const seen = new Set();
  return components.filter(component => {
    if (component.length < 2) return false;
    const key = JSON.stringify(component);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const rawByName = new Map();
raw.elements.forEach(element => {
  const name = element.tags?.name;
  if (!rawByName.has(name)) rawByName.set(name, []);
  rawByName.get(name).push(element);
});
const aliasByName = new Map();
aliases.elements.forEach(element => {
  const name = element.tags?.name;
  if (!aliasByName.has(name)) aliasByName.set(name, []);
  aliasByName.get(name).push(element);
});

const arterials = names.map(name => {
  let components = elementComponents(rawByName.get(name) || [], ROAD_BOXES.get(name) || SEOUL_BOX);
  if (name === "경부간선도로") {
    components = elementComponents(aliasByName.get("경부고속도로") || []);
  } else if (name === "동부간선도로") {
    components = elementComponents(aliasByName.get("동부간선로") || []);
  } else if (name === "미아로") {
    components = elementComponents(rawByName.get("동소문로") || [], MIA_BOX);
  } else if (name === "사평로") {
    components = featureComponents(sapyeong);
  } else if (name === "여의대로") {
    components = featureComponents(yeouidaero.filter(feature => feature.type !== "primary_link"));
  }
  if (!components.length && naverOnly.has(name)) components = naverComponents(naverOnly.get(name));
  return { name, components: uniqueComponents(components) };
});

const noGeometry = arterials.filter(road => road.components.length === 0).map(road => road.name);
if (noGeometry.length) {
  throw new Error(`unexpected roads without OSM line geometry: ${noGeometry.join(", ")}`);
}

const output = [
  "// OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright",
  `window.SEOUL_ARTERIALS = ${JSON.stringify(arterials)};`,
  "",
].join("\n");
fs.writeFileSync(path.join(root, "web", "seoul-arterials.js"), output);

const componentCount = arterials.reduce((sum, road) => sum + road.components.length, 0);
const pointCount = arterials.reduce((sum, road) =>
  sum + road.components.reduce((roadSum, component) => roadSum + component.length, 0), 0);
console.log(JSON.stringify({ roads: arterials.length, componentCount, pointCount, noGeometry }, null, 2));
