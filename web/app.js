const SVG_NS = "http://www.w3.org/2000/svg";
const BASE_VIEW = { x: 0, y: 0, width: 920, height: 760 };
const MAX_ZOOM = 16;
const NATIONAL_MAP_BOUNDS = { minLon: 124.55, maxLon: 131, minLat: 33.1, maxLat: 38.75 };
const SEOUL_FALLBACK_BOUNDS = { minLon: 126.76, maxLon: 127.22, minLat: 37.40, maxLat: 37.72 };
const MAP_FRAME = { left: 70, right: 850, top: 28, bottom: 732 };
const LANE_OFFSET_PX = 3.2;
const ROAD_TRACK_SPACING_PX = 14;
const EDGE_CASING_WIDTH_PX = 5.4;
const NODE_RADIUS_PX = 3.6;
const TRAVEL_HOVER_OPEN_DELAY = 120;
const TRAVEL_HOVER_CLOSE_DELAY = 140;
const view = { ...BASE_VIEW };
let mapBounds = { ...NATIONAL_MAP_BOUNDS };
const state = {
  mode: "national",
  payload: null,
  selectedRoads: new Set(),
  roadQuery: "",
  flow: "all",
  modeStates: {
    national: { payload: null, selectedRoads: new Set(), roadQuery: "", view: { ...BASE_VIEW } },
    seoul: { payload: null, selectedRoads: new Set(), roadQuery: "", view: { ...BASE_VIEW } },
  },
  travelTimes: {
    open: false,
    groups: [],
    selectedId: null,
  },
};
let panStart = null;
let pathGeometries = [];
let basePathSegments = [];
let labelGeometries = [];
let travelOpenTimer = null;
let travelCloseTimer = null;
let networkRequestSerial = 0;
const travelHoverMedia = window.matchMedia("(hover: hover) and (pointer: fine)");

const SPEED_SCALES = {
  national: {
    limits: { fast: 80, normal: 50, slow: 30, jam: 20 },
    jamIncludesLimit: false,
    ranges: {
      fast: "80km/h 이상",
      normal: "50–79km/h",
      slow: "30–49km/h",
      jam: "21–29km/h",
      critical: "20km/h 이하",
    },
    criticalButton: "20↓",
  },
  seoul: {
    limits: { fast: 50, normal: 30, slow: 20, jam: 10 },
    jamIncludesLimit: true,
    ranges: {
      fast: "50km/h 이상",
      normal: "30–49km/h",
      slow: "20–29km/h",
      jam: "10–19km/h",
      critical: "10km/h 미만",
    },
    criticalButton: "<10",
  },
};

const elements = {
  svg: document.querySelector("#traffic-graph"),
  arterials: document.querySelector("#arterial-layer"),
  edges: document.querySelector("#edge-layer"),
  labels: document.querySelector("#label-layer"),
  nodes: document.querySelector("#node-layer"),
  outline: document.querySelector("#map-outline"),
  roadList: document.querySelector("#road-list"),
  roadSearch: document.querySelector("#road-search"),
  clearRoadSearch: document.querySelector("#clear-road-search"),
  roadSearchStatus: document.querySelector("#road-search-status"),
  roadPanelTitle: document.querySelector("#road-panel-title"),
  roadSearchLabel: document.querySelector("#road-search-label"),
  toggleRoads: document.querySelector("#toggle-roads"),
  loading: document.querySelector("#loading-state"),
  empty: document.querySelector("#empty-state"),
  tooltip: document.querySelector("#tooltip"),
  refresh: document.querySelector("#refresh-button"),
  liveState: document.querySelector("#live-state"),
  updatedAt: document.querySelector("#updated-at"),
  zoomReset: document.querySelector("#zoom-reset"),
  graphEyebrow: document.querySelector("#graph-eyebrow"),
  graphHeading: document.querySelector("#graph-heading"),
  graphTitle: document.querySelector("#graph-title"),
  graphDescription: document.querySelector("#graph-description"),
  scopeStatus: document.querySelector("#scope-status"),
  travelDrawer: document.querySelector("#travel-time-drawer"),
  travelToggle: document.querySelector("#travel-time-toggle"),
  travelPanel: document.querySelector("#travel-time-panel"),
  travelUpdated: document.querySelector("#travel-time-updated"),
  travelStatus: document.querySelector("#travel-time-status"),
  travelRoutes: document.querySelector("#travel-time-routes"),
  travelGroups: document.querySelector("#travel-time-groups"),
};

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  return element;
}

function mercator(lon, lat) {
  const longitude = lon * Math.PI / 180;
  const latitude = clamp(lat, -85, 85) * Math.PI / 180;
  return { x: longitude, y: Math.log(Math.tan(Math.PI / 4 + latitude / 2)) };
}

function project(lon, lat) {
  const southwest = mercator(mapBounds.minLon, mapBounds.minLat);
  const northeast = mercator(mapBounds.maxLon, mapBounds.maxLat);
  const coordinate = mercator(lon, lat);
  const frameWidth = MAP_FRAME.right - MAP_FRAME.left;
  const frameHeight = MAP_FRAME.bottom - MAP_FRAME.top;
  const scale = Math.min(frameWidth / (northeast.x - southwest.x), frameHeight / (northeast.y - southwest.y));
  const drawnWidth = (northeast.x - southwest.x) * scale;
  const drawnHeight = (northeast.y - southwest.y) * scale;
  const originX = MAP_FRAME.left + (frameWidth - drawnWidth) / 2;
  const originY = MAP_FRAME.top + (frameHeight - drawnHeight) / 2;
  return {
    x: originX + (coordinate.x - southwest.x) * scale,
    y: originY + drawnHeight - (coordinate.y - southwest.y) * scale,
  };
}

function speedClass(speed, mode = state.mode) {
  if (speed == null) return "unknown";
  const scale = SPEED_SCALES[mode] || SPEED_SCALES.national;
  if (speed >= scale.limits.fast) return "fast";
  if (speed >= scale.limits.normal) return "normal";
  if (speed >= scale.limits.slow) return "slow";
  if (scale.jamIncludesLimit ? speed >= scale.limits.jam : speed > scale.limits.jam) return "jam";
  return "critical";
}

function speedColor(speed) {
  return {
    fast: "#45dc86", normal: "#d1e640", slow: "#ff9d3d",
    jam: "#ff5263", critical: "#cf3cff", unknown: "#71807b",
  }[speedClass(speed)];
}

function formatDuration(seconds) {
  if (!seconds) return "정보 없음";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? `${hours}시간 ${remainder}분` : `${hours}시간`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[character]);
}

function pixelsToMap() {
  const matrix = elements.svg.getScreenCTM?.();
  if (matrix) {
    const scale = Math.hypot(matrix.a, matrix.b);
    if (Number.isFinite(scale) && scale > 0) return 1 / scale;
  }
  const rectangle = elements.svg.getBoundingClientRect();
  const scale = Math.min(
    rectangle.width / view.width || 1,
    rectangle.height / view.height || 1,
  );
  return 1 / scale;
}

function clientToMapPoint(clientX, clientY) {
  const matrix = elements.svg.getScreenCTM?.();
  if (matrix) {
    const point = elements.svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(matrix.inverse());
  }
  const rectangle = elements.svg.getBoundingClientRect();
  const scale = 1 / pixelsToMap();
  const letterboxX = (rectangle.width - view.width * scale) / 2;
  const letterboxY = (rectangle.height - view.height * scale) / 2;
  return {
    x: view.x + (clientX - rectangle.left - letterboxX) / scale,
    y: view.y + (clientY - rectangle.top - letterboxY) / scale,
  };
}

function cleanPolyline(points) {
  const cleaned = [];
  points.forEach(point => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const previous = cleaned.at(-1);
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > .0001) {
      cleaned.push(point);
    }
  });
  return cleaned;
}

function polylineMetrics(points) {
  const frames = [];
  const cumulative = [0];
  for (let index = 0; index < points.length - 1; index += 1) {
    const dx = points[index + 1].x - points[index].x;
    const dy = points[index + 1].y - points[index].y;
    const length = Math.hypot(dx, dy);
    frames.push({
      length,
      tangent: { x: dx / length, y: dy / length },
      normal: { x: -dy / length, y: dx / length },
    });
    cumulative.push(cumulative.at(-1) + length);
  }
  return { points, frames, cumulative, total: cumulative.at(-1) };
}

function offsetPointAtDistance(metrics, distance, offset) {
  const { points, frames, cumulative, total } = metrics;
  const bounded = clamp(distance, 0, total);
  let low = 0, high = cumulative.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (cumulative[middle] < bounded) low = middle + 1;
    else high = middle;
  }
  let vertexIndex = -1;
  if (low < cumulative.length && Math.abs(cumulative[low] - bounded) < .0001) vertexIndex = low;
  else if (low > 0 && Math.abs(cumulative[low - 1] - bounded) < .0001) vertexIndex = low - 1;
  if (vertexIndex >= 0) {
    const point = points[vertexIndex];
    if (vertexIndex === 0 || vertexIndex === points.length - 1) {
      const frame = frames[vertexIndex === 0 ? 0 : frames.length - 1];
      return { x: point.x + frame.normal.x * offset, y: point.y + frame.normal.y * offset };
    }
    const previous = frames[vertexIndex - 1].normal;
    const next = frames[vertexIndex].normal;
    const sumLength = Math.hypot(previous.x + next.x, previous.y + next.y);
    if (sumLength > .001) {
      const miter = { x: (previous.x + next.x) / sumLength, y: (previous.y + next.y) / sumLength };
      const denominator = miter.x * next.x + miter.y * next.y;
      const rawLength = Math.abs(denominator) > .2 ? offset / denominator : offset;
      const limit = Math.max(Math.abs(offset) * 2, .0001);
      const miterLength = clamp(rawLength, -limit, limit);
      return { x: point.x + miter.x * miterLength, y: point.y + miter.y * miterLength };
    }
    return { x: point.x + next.x * offset, y: point.y + next.y * offset };
  }

  const segmentIndex = clamp(low - 1, 0, frames.length - 1);
  const frame = frames[segmentIndex];
  const ratio = (bounded - cumulative[segmentIndex]) / frame.length;
  const point = {
    x: points[segmentIndex].x + (points[segmentIndex + 1].x - points[segmentIndex].x) * ratio,
    y: points[segmentIndex].y + (points[segmentIndex + 1].y - points[segmentIndex].y) * ratio,
  };
  return { x: point.x + frame.normal.x * offset, y: point.y + frame.normal.y * offset };
}

function parallelPolyline(rawPoints, screenOffset, endpointOffset, unit, connectStart, connectEnd) {
  const points = cleanPolyline(rawPoints);
  if (points.length < 2) return { d: "", segments: [] };
  const metrics = polylineMetrics(points);
  if (!Number.isFinite(metrics.total) || metrics.total <= .0001) return { d: "", segments: [] };

  const endpoint = endpointOffset * unit;
  const nodeRadius = NODE_RADIUS_PX * unit;
  let startDistance = connectStart
    ? Math.sqrt(Math.max(0, nodeRadius ** 2 - endpoint ** 2))
    : 0;
  let endDistance = connectEnd ? metrics.total - startDistance : metrics.total;
  if (startDistance >= endDistance) {
    startDistance = 0;
    endDistance = metrics.total;
  }
  const available = endDistance - startDistance;
  const transition = Math.min(available * .25, (Math.abs(screenOffset - endpointOffset) + 7) * unit);
  const distances = [startDistance, endDistance];
  metrics.cumulative.slice(1, -1).forEach(distance => {
    if (distance > startDistance && distance < endDistance) distances.push(distance);
  });
  if (connectStart && transition > .0001) distances.push(startDistance + transition);
  if (connectEnd && transition > .0001) distances.push(endDistance - transition);
  distances.sort((first, second) => first - second);
  const uniqueDistances = distances.filter((distance, index) =>
    index === 0 || distance - distances[index - 1] > .0001);

  const rendered = uniqueDistances.map(distance => {
    let factor = 1;
    if (connectStart && transition > .0001) {
      const progress = clamp((distance - startDistance) / transition, 0, 1);
      factor = Math.min(factor, progress * progress * (3 - 2 * progress));
    }
    if (connectEnd && transition > .0001) {
      const progress = clamp((endDistance - distance) / transition, 0, 1);
      factor = Math.min(factor, progress * progress * (3 - 2 * progress));
    }
    const offset = (endpointOffset + (screenOffset - endpointOffset) * factor) * unit;
    return offsetPointAtDistance(metrics, distance, offset);
  });
  const segments = [];
  for (let index = 0; index < rendered.length - 1; index += 1) {
    segments.push({ start: rendered[index], end: rendered[index + 1] });
  }
  return {
    d: rendered.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" "),
    segments,
  };
}

function parallelShape(shape, screenOffset, endpointOffset, unit, fromPoint, toPoint) {
  const paths = [];
  const segments = [];
  shape.forEach(points => {
    const first = points[0], last = points.at(-1);
    const connects = point => Math.min(
      Math.hypot(point.x - fromPoint.x, point.y - fromPoint.y),
      Math.hypot(point.x - toPoint.x, point.y - toPoint.y),
    ) < .001;
    const geometry = parallelPolyline(
      points,
      screenOffset,
      endpointOffset,
      unit,
      connects(first),
      connects(last),
    );
    if (geometry.d) paths.push(geometry.d);
    segments.push(...geometry.segments);
  });
  return { d: paths.join(" "), segments };
}

function projectEdgeShape(edge) {
  const fallback = [[[edge.from.lon, edge.from.lat], [edge.to.lon, edge.to.lat]]];
  const rawShape = Array.isArray(edge.shape) && edge.shape.length ? edge.shape : fallback;
  const components = Array.isArray(rawShape[0]?.[0]) ? rawShape : [rawShape];
  const projected = components.map(component => component
    .filter(coordinate => Array.isArray(coordinate) && coordinate.length >= 2)
    .map(([lon, lat]) => project(lon, lat)))
    .map(cleanPolyline)
    .filter(component => component.length >= 2);
  return projected.length ? projected : fallback.map(component =>
    component.map(([lon, lat]) => project(lon, lat)));
}

function projectBaseRoad(road) {
  return (Array.isArray(road.components) ? road.components : [])
    .map(component => (Array.isArray(component) ? component : [])
      .filter(coordinate => Array.isArray(coordinate) && coordinate.length >= 2)
      .map(([lon, lat]) => project(lon, lat)))
    .map(cleanPolyline)
    .filter(component => component.length >= 2);
}

function componentPath(component) {
  return component.map((point, index) =>
    `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
}

function componentSegments(component) {
  const segments = [];
  for (let index = 0; index < component.length - 1; index += 1) {
    segments.push({ start: component[index], end: component[index + 1] });
  }
  return segments;
}

function boundsForEdges(edges, fallback, baseRoadGeometries = []) {
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  const include = ([lon, lat]) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  };
  edges.forEach(edge => {
    include([edge.from.lon, edge.from.lat]);
    include([edge.to.lon, edge.to.lat]);
    (Array.isArray(edge.shape) ? edge.shape : []).forEach(component =>
      (Array.isArray(component) ? component : []).forEach(include));
  });
  baseRoadGeometries.forEach(road =>
    (Array.isArray(road.components) ? road.components : []).forEach(component =>
      (Array.isArray(component) ? component : []).forEach(include)));
  if (![minLon, maxLon, minLat, maxLat].every(Number.isFinite)) return { ...fallback };
  const lonPadding = Math.max((maxLon - minLon) * .06, .015);
  const latPadding = Math.max((maxLat - minLat) * .08, .012);
  return {
    minLon: minLon - lonPadding,
    maxLon: maxLon + lonPadding,
    minLat: minLat - latPadding,
    maxLat: maxLat + latPadding,
  };
}

function configureMapProjection(payload) {
  mapBounds = state.mode === "seoul"
    ? boundsForEdges(
      payload?.edges || [], SEOUL_FALLBACK_BOUNDS, payload?.baseRoadGeometries || [],
    )
    : { ...NATIONAL_MAP_BOUNDS };
  renderOutline();
}

function renderOutline() {
  if (state.mode === "seoul") {
    elements.outline.replaceChildren();
    return;
  }
  const fragment = document.createDocumentFragment();
  KOREA_BOUNDARY.forEach(polygon => {
    const paths = polygon.map(ring => ring.map(([lon, lat], index) => {
      const point = project(lon, lat);
      return `${index ? "L" : "M"} ${point.x} ${point.y}`;
    }).join(" ") + " Z");
    fragment.append(svgElement("path", { d: paths.join(" "), class: "map-outline", "fill-rule": "evenodd" }));
  });
  elements.outline.replaceChildren(fragment);
}

function shouldShowDirection(traffic) {
  return state.flow === "all" || speedClass(traffic.speedKmh) === state.flow;
}

function corridorOffsets(edges) {
  const groups = new Map();
  edges.forEach(edge => {
    const key = [junctionKey(edge.from), junctionKey(edge.to)].sort().join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(edge);
  });
  const offsets = new Map();
  groups.forEach(group => {
    const roadIds = [...new Set(group.map(edge => edge.roadId))].sort((a, b) => a - b);
    group.forEach(edge => {
      const index = roadIds.indexOf(edge.roadId);
      const canonicalDirection = junctionKey(edge.from) <= junctionKey(edge.to) ? 1 : -1;
      offsets.set(edge, (index - (roadIds.length - 1) / 2) * ROAD_TRACK_SPACING_PX * canonicalDirection);
    });
  });
  return offsets;
}

function renderGraph() {
  if (!state.payload) return;
  const baseRoads = (state.payload.baseRoadGeometries || [])
    .filter(road => state.selectedRoads.has(road.roadId));
  const roadEdges = state.payload.edges.filter(edge => state.selectedRoads.has(edge.roadId));
  const networkDegrees = new Map();
  state.payload.edges.forEach(edge => {
    [edge.from, edge.to].forEach(node => {
      const key = junctionKey(node);
      networkDegrees.set(key, (networkDegrees.get(key) || 0) + 1);
    });
  });
  const unit = pixelsToMap();
  const sharedCorridorOffsets = corridorOffsets(roadEdges);
  const baseFragment = document.createDocumentFragment();
  const edgeFragment = document.createDocumentFragment();
  const labelFragment = document.createDocumentFragment();
  const nodeFragment = document.createDocumentFragment();
  const junctions = new Map();
  pathGeometries = [];
  basePathSegments = [];
  labelGeometries = [];
  let renderedDirections = 0;
  let renderedBaseRoads = 0;

  baseRoads.forEach(road => {
    const components = projectBaseRoad(road);
    if (!components.length) return;
    const path = svgElement("path", {
      d: components.map(componentPath).join(" "),
      class: "arterial-base-road",
      "data-road-id": road.roadId,
    });
    baseFragment.append(path);
    basePathSegments.push(...components.flatMap(componentSegments));
    renderedBaseRoads += 1;
  });

  roadEdges.forEach(edge => {
    const start = project(edge.from.lon, edge.from.lat);
    const end = project(edge.to.lon, edge.to.lat);
    const shape = projectEdgeShape(edge);
    const corridorOffset = sharedCorridorOffsets.get(edge) || 0;
    let edgeVisible = false;

    [
      // SVG coordinates grow downward, so the positive normal is the
      // right-hand side of the stored from → to direction.
      { key: "down", laneOffset: LANE_OFFSET_PX },
      { key: "up", laneOffset: -LANE_OFFSET_PX },
    ].forEach(direction => {
      const traffic = edge[direction.key];
      if (!shouldShowDirection(traffic)) return;
      edgeVisible = true;
      renderedDirections += 1;
      const isDown = direction.key === "down";
      const from = isDown ? edge.from : edge.to;
      const to = isDown ? edge.to : edge.from;
      const destination = isDown ? edge.downLabel : edge.upLabel;
      const directionText = destination ? `${destination} 방면` : isDown ? "기점 → 종점" : "종점 → 기점";
      const screenOffset = corridorOffset + direction.laneOffset;
      const geometry = parallelShape(
        shape, screenOffset, direction.laneOffset, unit, start, end,
      );
      const group = svgElement("g", {
        class: `edge-group direction-${direction.key}`,
        tabindex: "0",
        role: "img",
        "aria-label": `${from.name}에서 ${to.name}, ${directionText}, ${formatDuration(traffic.durationSeconds)}`,
      });
      const casing = svgElement("path", { d: geometry.d, class: "road-edge-casing" });
      const color = svgElement("path", { d: geometry.d, class: "road-edge", stroke: speedColor(traffic.speedKmh) });
      const hit = svgElement("path", { d: geometry.d, class: "road-edge-hit" });
      group.addEventListener("pointerenter", event => {
        if (event.pointerType !== "touch") showTooltip(event, edge, traffic, direction.key);
      });
      group.addEventListener("pointermove", moveTooltip);
      group.addEventListener("pointerleave", hideTooltip);
      group.addEventListener("pointerdown", event => event.preventDefault());
      group.addEventListener("focus", event => {
        if (group.matches(":focus-visible")) showTooltip(event, edge, traffic, direction.key);
      });
      group.addEventListener("blur", hideTooltip);
      group.append(casing, color, hit);
      edgeFragment.append(group);
      pathGeometries.push({
        shape, start, end, screenOffset, endpointOffset: direction.laneOffset,
        paths: [casing, color, hit], geometry,
      });
    });

    if (edgeVisible) {
      [edge.from, edge.to].forEach(node => {
        const key = junctionKey(node);
        const known = junctions.get(key);
        if (known) {
          known.degree += 1;
          known.node.major ||= node.major;
        } else {
          junctions.set(key, { node: { ...node }, degree: 1 });
        }
      });
    }
  });

  [...junctions.values()]
    .map(item => ({
      ...item,
      primary: isPrimaryJunction(item.node, networkDegrees.get(junctionKey(item.node)) || item.degree),
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || b.degree - a.degree)
    .forEach(({ node, degree, primary }) => {
      const point = project(node.lon, node.lat);
      const kind = primary ? "primary" : node.major ? "junction" : "minor";
      const circle = svgElement("circle", {
        cx: point.x, cy: point.y, r: NODE_RADIUS_PX * unit,
        class: `node is-${kind}`,
      });
      nodeFragment.append(circle);
      const label = createNodeLabel(node, point, degree, kind);
      labelGeometries.push(label);
      labelFragment.append(label.group);
    });

  elements.arterials.replaceChildren(baseFragment);
  elements.edges.replaceChildren(edgeFragment);
  elements.labels.replaceChildren(labelFragment);
  elements.nodes.replaceChildren(nodeFragment);
  elements.empty.hidden = renderedDirections > 0 || renderedBaseRoads > 0;
  updateZoomDependentStyles(false);
}

function isPrimaryJunction(node, degree) {
  return node.major && (degree >= 3 || ["한남IC", "서서울톨게이트", "부산", "강릉JC"].includes(node.name));
}

function createNodeLabel(node, point, degree, kind) {
  const width = Math.max(34, [...node.name].length * 8 + 12);
  const height = 18;
  const group = svgElement("g", {
    class: `node-label-group is-${kind}`,
    "data-x": point.x,
    "data-y": point.y,
    "data-degree": degree,
  });
  const leader = svgElement("line", { x1: 0, y1: 0, class: "node-label-leader" });
  const background = svgElement("rect", { width, height, rx: 4 });
  const text = svgElement("text", { class: "node-label" });
  text.textContent = node.name;
  group.append(leader, background, text);
  return { group, leader, background, text, point, degree, kind, width, height };
}

function labelCandidates(width, height, primary) {
  const candidates = [];
  const radii = primary
    ? [12, 20, 30, 42, 56, 74, 96, 122, 154, 190]
    : [9, 17, 27, 39, 52, 68, 86];
  radii.forEach(radius => {
    candidates.push(
      { x: radius, y: -height - 3 },
      { x: radius, y: 4 },
      { x: -width - radius, y: -height - 3 },
      { x: -width - radius, y: 4 },
      { x: -width / 2, y: -height - radius },
      { x: -width / 2, y: radius },
      { x: radius, y: -height / 2 },
      { x: -width - radius, y: -height / 2 },
    );
  });
  return candidates;
}

function buildSegmentGrid(segments, cellSize) {
  const cells = new Map();
  const viewMinX = Math.floor(view.x / cellSize) - 1;
  const viewMaxX = Math.floor((view.x + view.width) / cellSize) + 1;
  const viewMinY = Math.floor(view.y / cellSize) - 1;
  const viewMaxY = Math.floor((view.y + view.height) / cellSize) + 1;
  const add = (x, y, index) => {
    if (x < viewMinX || x > viewMaxX || y < viewMinY || y > viewMaxY) return;
    const key = `${x}:${y}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(index);
  };
  segments.forEach((segment, index) => {
    const minX = Math.min(segment.start.x, segment.end.x);
    const maxX = Math.max(segment.start.x, segment.end.x);
    const minY = Math.min(segment.start.y, segment.end.y);
    const maxY = Math.max(segment.start.y, segment.end.y);
    if (maxX < view.x || minX > view.x + view.width || maxY < view.y || minY > view.y + view.height) return;

    let x = Math.floor(segment.start.x / cellSize);
    let y = Math.floor(segment.start.y / cellSize);
    const endX = Math.floor(segment.end.x / cellSize);
    const endY = Math.floor(segment.end.y / cellSize);
    const dx = segment.end.x - segment.start.x;
    const dy = segment.end.y - segment.start.y;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    const deltaX = stepX ? cellSize / Math.abs(dx) : Number.POSITIVE_INFINITY;
    const deltaY = stepY ? cellSize / Math.abs(dy) : Number.POSITIVE_INFINITY;
    const nextBoundaryX = (x + (stepX > 0 ? 1 : 0)) * cellSize;
    const nextBoundaryY = (y + (stepY > 0 ? 1 : 0)) * cellSize;
    let maxTravelX = stepX ? (nextBoundaryX - segment.start.x) / dx : Number.POSITIVE_INFINITY;
    let maxTravelY = stepY ? (nextBoundaryY - segment.start.y) / dy : Number.POSITIVE_INFINITY;
    const safetyLimit = Math.abs(endX - x) + Math.abs(endY - y) + 3;
    for (let step = 0; step < safetyLimit; step += 1) {
      add(x, y, index);
      if (x === endX && y === endY) break;
      if (maxTravelX < maxTravelY) {
        x += stepX;
        maxTravelX += deltaX;
      } else if (maxTravelY < maxTravelX) {
        y += stepY;
        maxTravelY += deltaY;
      } else {
        // A segment crossing a grid corner belongs to both neighboring cells.
        // Registering only the diagonal cell can make collision queries miss it.
        add(x + stepX, y, index);
        add(x, y + stepY, index);
        x += stepX;
        y += stepY;
        maxTravelX += deltaX;
        maxTravelY += deltaY;
      }
    }
  });
  return { cells, segments, cellSize };
}

function countLineCollisions(grid, rectangle, padding) {
  const left = rectangle.x - padding;
  const right = rectangle.x + rectangle.width + padding;
  const top = rectangle.y - padding;
  const bottom = rectangle.y + rectangle.height + padding;
  const indexes = new Set();
  for (let x = Math.floor(left / grid.cellSize); x <= Math.floor(right / grid.cellSize); x += 1) {
    for (let y = Math.floor(top / grid.cellSize); y <= Math.floor(bottom / grid.cellSize); y += 1) {
      (grid.cells.get(`${x}:${y}`) || []).forEach(index => indexes.add(index));
    }
  }
  let collisions = 0;
  indexes.forEach(index => {
    const segment = grid.segments[index];
    if (segmentIntersectsRectangle(segment.start, segment.end, rectangle, padding)) collisions += 1;
  });
  return collisions;
}

function findPrimaryFallback(label, mapScale, occupied, segmentGrid, labelMargin, linePadding, viewMargin) {
  const width = label.width * mapScale;
  const height = label.height * mapScale;
  const stepX = (label.width + 10) * mapScale;
  const stepY = (label.height + 10) * mapScale;
  let best = null;
  for (let y = view.y + viewMargin; y + height <= view.y + view.height - viewMargin; y += stepY) {
    for (let x = view.x + viewMargin; x + width <= view.x + view.width - viewMargin; x += stepX) {
      const rectangle = { x, y, width, height };
      if (occupied.some(other => rectanglesOverlap(rectangle, other, labelMargin))) continue;
      const lineCollisions = countLineCollisions(segmentGrid, rectangle, linePadding);
      const centerDistance = Math.hypot(x + width / 2 - label.point.x, y + height / 2 - label.point.y) / mapScale;
      const score = lineCollisions * 1_000_000 + centerDistance;
      if (!best || score < best.score) {
        best = {
          candidate: { x: (x - label.point.x) / mapScale, y: (y - label.point.y) / mapScale },
          rectangle,
          score,
          collisions: { labels: 0, lines: lineCollisions, outside: false },
        };
      }
    }
  }
  return best;
}

function layoutLabels(zoom, unit) {
  const occupied = [];
  const lineSegments = [
    ...basePathSegments,
    ...pathGeometries.flatMap(path => path.geometry.segments),
  ];
  const segmentGrid = buildSegmentGrid(lineSegments, Math.max(32 * unit, .01));
  const labelScreenScale = 1 + Math.min(.24, Math.log2(zoom) * .08);
  const mapScale = unit * labelScreenScale;
  const labelMargin = 3 * unit;
  const linePadding = (EDGE_CASING_WIDTH_PX / 2 + 2) * unit;
  const viewMargin = 5 * unit;

  labelGeometries.forEach(label => {
    const threshold = label.kind === "primary" ? 1 : label.kind === "junction" ? 1.6 : 2.4;
    const pointVisible = label.point.x >= view.x - viewMargin && label.point.x <= view.x + view.width + viewMargin &&
      label.point.y >= view.y - viewMargin && label.point.y <= view.y + view.height + viewMargin;
    if (zoom < threshold || !pointVisible) {
      label.group.style.display = "none";
      return;
    }

    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestCollisions = null;
    const candidates = labelCandidates(label.width, label.height, label.kind === "primary");
    for (const candidate of candidates) {
      const rectangle = {
        x: label.point.x + candidate.x * mapScale,
        y: label.point.y + candidate.y * mapScale,
        width: label.width * mapScale,
        height: label.height * mapScale,
      };
      const labelCollisions = occupied.filter(other => rectanglesOverlap(rectangle, other, labelMargin)).length;
      const lineCollisions = countLineCollisions(segmentGrid, rectangle, linePadding);
      const outside = rectangle.x < view.x + viewMargin || rectangle.y < view.y + viewMargin ||
        rectangle.x + rectangle.width > view.x + view.width - viewMargin ||
        rectangle.y + rectangle.height > view.y + view.height - viewMargin;
      const score = Number(outside) * 10_000_000 + labelCollisions * 1_000_000 + lineCollisions * 1_000;
      if (score < bestScore) {
        best = { candidate, rectangle };
        bestScore = score;
        bestCollisions = { labels: labelCollisions, lines: lineCollisions, outside };
      }
      if (!outside && labelCollisions === 0 && lineCollisions === 0) break;
    }

    let collisionFree = bestCollisions && !bestCollisions.outside &&
      bestCollisions.labels === 0 && bestCollisions.lines === 0;
    if (label.kind === "primary" && !collisionFree) {
      const fallback = findPrimaryFallback(
        label, mapScale, occupied, segmentGrid, labelMargin, linePadding, viewMargin,
      );
      if (fallback && (!best || fallback.collisions.lines < bestCollisions.lines ||
        bestCollisions.labels > 0 || bestCollisions.outside)) {
        best = { candidate: fallback.candidate, rectangle: fallback.rectangle };
        bestScore = fallback.score;
        bestCollisions = fallback.collisions;
        collisionFree = bestCollisions.lines === 0;
      }
    }
    const primaryFallback = label.kind === "primary" && bestCollisions &&
      !bestCollisions.outside && bestCollisions.labels === 0;
    if (!best || (!collisionFree && !primaryFallback)) {
      label.group.style.display = "none";
      return;
    }

    const { candidate, rectangle } = best;
    label.group.style.display = "";
    label.group.dataset.placementScore = String(bestScore);
    label.group.setAttribute("transform", `translate(${label.point.x} ${label.point.y}) scale(${mapScale})`);
    label.background.setAttribute("x", candidate.x);
    label.background.setAttribute("y", candidate.y);
    label.text.setAttribute("x", candidate.x + 6);
    label.text.setAttribute("y", candidate.y + 12);
    const leaderVisible = Math.hypot(candidate.x, candidate.y) > 25;
    label.leader.style.display = leaderVisible ? "" : "none";
    if (leaderVisible) {
      label.leader.setAttribute("x2", clamp(0, candidate.x, candidate.x + label.width));
      label.leader.setAttribute("y2", clamp(0, candidate.y, candidate.y + label.height));
    }
    occupied.push(rectangle);
  });
}

function junctionKey(node) {
  return `${node.lon.toFixed(5)}|${node.lat.toFixed(5)}`;
}

function rectanglesOverlap(a, b, margin = 0) {
  return a.x - margin < b.x + b.width && a.x + a.width + margin > b.x &&
    a.y - margin < b.y + b.height && a.y + a.height + margin > b.y;
}

function segmentIntersectsRectangle(start, end, rectangle, padding = 0) {
  const expanded = {
    left: rectangle.x - padding, right: rectangle.x + rectangle.width + padding,
    top: rectangle.y - padding, bottom: rectangle.y + rectangle.height + padding,
  };
  if (pointInRectangle(start, expanded) || pointInRectangle(end, expanded)) return true;
  const topLeft = { x: expanded.left, y: expanded.top };
  const topRight = { x: expanded.right, y: expanded.top };
  const bottomLeft = { x: expanded.left, y: expanded.bottom };
  const bottomRight = { x: expanded.right, y: expanded.bottom };
  return segmentsIntersect(start, end, topLeft, topRight) ||
    segmentsIntersect(start, end, topRight, bottomRight) ||
    segmentsIntersect(start, end, bottomRight, bottomLeft) ||
    segmentsIntersect(start, end, bottomLeft, topLeft);
}

function pointInRectangle(point, rectangle) {
  return point.x >= rectangle.left && point.x <= rectangle.right &&
    point.y >= rectangle.top && point.y <= rectangle.bottom;
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const onSegment = (p, q, r) =>
    q.x >= Math.min(p.x, r.x) - 1e-9 && q.x <= Math.max(p.x, r.x) + 1e-9 &&
    q.y >= Math.min(p.y, r.y) - 1e-9 && q.y <= Math.max(p.y, r.y) + 1e-9;
  const abC = cross(a, b, c), abD = cross(a, b, d);
  const cdA = cross(c, d, a), cdB = cross(c, d, b);
  const epsilon = 1e-9;
  if (Math.abs(abC) <= epsilon && onSegment(a, c, b)) return true;
  if (Math.abs(abD) <= epsilon && onSegment(a, d, b)) return true;
  if (Math.abs(cdA) <= epsilon && onSegment(c, a, d)) return true;
  if (Math.abs(cdB) <= epsilon && onSegment(c, b, d)) return true;
  return ((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) &&
    ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon));
}

function showTooltip(event, edge, traffic, direction) {
  if (state.travelTimes.open) return;
  const isDown = direction === "down";
  const from = isDown ? edge.from : edge.to;
  const to = isDown ? edge.to : edge.from;
  const destination = isDown ? edge.downLabel : edge.upLabel;
  const flow = speedClass(traffic.speedKmh);
  const flowLabel = {
    fast: "원활", normal: "보통", slow: "서행", jam: "정체",
    critical: "극심", unknown: "정보 없음",
  }[flow];
  const directionText = destination ? `${destination} 방면` : isDown ? "기점 → 종점" : "종점 → 기점";
  elements.tooltip.innerHTML = `
    <div class="tooltip-head"><b>${escapeHtml(edge.roadNumber)}</b><strong>${escapeHtml(edge.roadName)}</strong></div>
    <div class="tooltip-route">${escapeHtml(from.name)} → ${escapeHtml(to.name)} · ${escapeHtml(directionText)}</div>
    <div class="tooltip-grid">
      <div><span>현재 소요시간</span><strong>${formatDuration(traffic.durationSeconds)}</strong></div>
      <div><span>계산 평균속도</span><strong style="color:${speedColor(traffic.speedKmh)}">${traffic.speedKmh ?? "--"} km/h</strong></div>
      <div><span>구간 거리</span><strong>${edge.distanceKm} km</strong></div>
      <div><span>소통 상태</span><strong>${flowLabel}</strong></div>
    </div>`;
  elements.tooltip.hidden = false;
  moveTooltip(event);
}

function moveTooltip(event) {
  if (elements.tooltip.hidden || panStart) return;
  const x = (event.clientX || innerWidth / 2) + 15;
  const y = (event.clientY || innerHeight / 2) + 15;
  elements.tooltip.style.left = `${Math.max(8, Math.min(x, innerWidth - 235))}px`;
  elements.tooltip.style.top = `${Math.max(8, Math.min(y, innerHeight - 190))}px`;
}

function hideTooltip() { elements.tooltip.hidden = true; }

function formatTravelDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "정보 없음";
  return formatDuration(seconds);
}

function clearTravelTimers() {
  window.clearTimeout(travelOpenTimer);
  window.clearTimeout(travelCloseTimer);
  travelOpenTimer = null;
  travelCloseTimer = null;
}

function setTravelDrawerOpen(open) {
  if (open && elements.travelToggle.disabled) return;
  clearTravelTimers();
  if (!open && elements.travelPanel.contains(document.activeElement)) {
    elements.travelToggle.focus({ preventScroll: true });
  }
  state.travelTimes.open = open;
  elements.travelDrawer.classList.toggle("is-open", open);
  elements.travelToggle.setAttribute("aria-expanded", String(open));
  elements.travelToggle.setAttribute("aria-label", `대표지역 이동시간 ${open ? "닫기" : "열기"}`);
  elements.travelPanel.setAttribute("aria-hidden", String(!open));
  elements.travelPanel.toggleAttribute("inert", !open);
  if (open) hideTooltip();
}

function scheduleTravelDrawerOpen() {
  if (!travelHoverMedia.matches || elements.travelToggle.disabled) return;
  window.clearTimeout(travelCloseTimer);
  travelCloseTimer = null;
  if (state.travelTimes.open) return;
  window.clearTimeout(travelOpenTimer);
  travelOpenTimer = window.setTimeout(() => {
    setTravelDrawerOpen(true);
  }, TRAVEL_HOVER_OPEN_DELAY);
}

function scheduleTravelDrawerClose() {
  window.clearTimeout(travelOpenTimer);
  travelOpenTimer = null;
  if (!travelHoverMedia.matches || !state.travelTimes.open) return;
  window.clearTimeout(travelCloseTimer);
  travelCloseTimer = window.setTimeout(() => {
    if (!elements.travelDrawer.matches(":hover") &&
      !elements.travelDrawer.contains(document.activeElement)) {
      setTravelDrawerOpen(false);
    }
  }, TRAVEL_HOVER_CLOSE_DELAY);
}

function closeTravelDrawerAndRestoreFocus() {
  elements.travelToggle.focus({ preventScroll: true });
  setTravelDrawerOpen(false);
}

function travelCorridorKey(group, index) {
  return group.id || `${group.roadNumber || "road"}-${index}`;
}

function createTravelVerticalTime(seconds, direction, row, isOrigin) {
  const element = document.createElement(isOrigin ? "small" : "time");
  element.className = `travel-vertical-time is-${direction}`;
  element.style.gridRow = String(row);

  if (isOrigin) {
    element.textContent = direction === "outbound" ? "출발" : "도착";
    return element;
  }

  const available = Number.isFinite(seconds) && seconds > 0;
  const fullDuration = formatTravelDuration(seconds);
  element.textContent = fullDuration;
  element.title = fullDuration;
  if (available) element.dateTime = `PT${Math.round(seconds)}S`;
  else element.classList.add("is-unavailable");
  return element;
}

function createTravelVerticalDiagram(group) {
  const origin = group.origin || "출발지";
  const destinations = Array.isArray(group.destinations) ? group.destinations : [];
  const stops = [{ name: origin, isOrigin: true }, ...destinations];
  const figure = document.createElement("div");
  figure.className = "travel-vertical";
  figure.setAttribute("aria-hidden", "true");

  const directionHead = document.createElement("div");
  directionHead.className = "travel-vertical-head";
  const outboundHead = document.createElement("span");
  outboundHead.className = "is-outbound";
  outboundHead.textContent = `${origin}에서 ↓`;
  const placeHead = document.createElement("b");
  placeHead.textContent = "지역";
  const inboundHead = document.createElement("span");
  inboundHead.className = "is-inbound";
  inboundHead.textContent = `↑ ${origin}까지`;
  directionHead.append(outboundHead, placeHead, inboundHead);

  const body = document.createElement("div");
  body.className = "travel-vertical-body";
  body.style.setProperty("--travel-stop-count", stops.length);

  ["outbound", "inbound"].forEach(direction => {
    const rail = document.createElement("span");
    rail.className = `travel-vertical-rail is-${direction}`;
    rail.style.gridRow = `1 / span ${stops.length}`;
    body.append(rail);
  });

  stops.forEach((stop, index) => {
    const row = index + 1;
    const outboundSeconds = stop.isOrigin ? null : stop.outboundSeconds;
    const inboundSeconds = stop.isOrigin ? null : stop.inboundSeconds;
    const outboundTick = document.createElement("span");
    outboundTick.className = `travel-vertical-node is-outbound${stop.isOrigin ? " is-origin" : ""}`;
    outboundTick.style.gridRow = String(row);
    const place = document.createElement("b");
    place.className = `travel-vertical-place${stop.isOrigin ? " is-origin" : ""}`;
    place.style.gridRow = String(row);
    place.textContent = stop.name || "목적지";
    const inboundTick = document.createElement("span");
    inboundTick.className = `travel-vertical-node is-inbound${stop.isOrigin ? " is-origin" : ""}`;
    inboundTick.style.gridRow = String(row);

    body.append(
      createTravelVerticalTime(outboundSeconds, "outbound", row, stop.isOrigin),
      outboundTick,
      place,
      inboundTick,
      createTravelVerticalTime(inboundSeconds, "inbound", row, stop.isOrigin),
    );
  });
  figure.append(directionHead, body);
  return figure;
}

function renderTravelTimeGroups(focusSelected = false) {
  const groups = state.travelTimes.groups;
  elements.travelRoutes.replaceChildren();
  elements.travelGroups.replaceChildren();

  if (!groups.length) {
    elements.travelRoutes.hidden = true;
    const empty = document.createElement("p");
    empty.className = "travel-time-empty";
    empty.textContent = "대표지역 이동시간 정보가 없습니다";
    elements.travelGroups.append(empty);
    return;
  }
  elements.travelRoutes.hidden = false;

  const keyedGroups = groups.map((group, index) => ({
    group,
    key: travelCorridorKey(group, index),
    index,
  }));
  if (!keyedGroups.some(entry => entry.key === state.travelTimes.selectedId)) {
    state.travelTimes.selectedId = keyedGroups[0].key;
  }

  let selectedButton = null;
  keyedGroups.forEach(({ group, key, index }) => {
    const destinations = Array.isArray(group.destinations) ? group.destinations : [];
    const origin = group.origin || "출발지";
    const destination = destinations.at(-1)?.name || "종점";
    const selected = key === state.travelTimes.selectedId;
    const button = document.createElement("button");
    button.className = "travel-route-button";
    button.type = "button";
    button.id = `travel-route-button-${index}`;
    button.setAttribute("aria-pressed", String(selected));
    button.setAttribute("aria-controls", "travel-route-detail");
    button.setAttribute("aria-label", `${group.roadName || "고속도로"}, ${origin}에서 ${destination} 구간`);
    if (selected) {
      button.classList.add("is-active");
      selectedButton = button;
    }
    const name = document.createElement("strong");
    name.textContent = group.roadName || "노선 정보 없음";
    const endpoints = document.createElement("small");
    endpoints.textContent = `${origin} ↔ ${destination}`;
    button.append(name, endpoints);
    button.addEventListener("click", () => {
      if (state.travelTimes.selectedId === key) return;
      state.travelTimes.selectedId = key;
      renderTravelTimeGroups(true);
    });
    elements.travelRoutes.append(button);
  });

  const selectedEntry = keyedGroups.find(entry => entry.key === state.travelTimes.selectedId);
  const group = selectedEntry.group;
  const destinations = Array.isArray(group.destinations) ? group.destinations : [];
  const origin = group.origin || "출발지";
  const section = document.createElement("section");
  section.className = "travel-route-card is-selected";
  section.id = "travel-route-detail";
  section.setAttribute("aria-labelledby", selectedButton.id);

  const header = document.createElement("header");
  header.className = "travel-route-head";
  const shield = document.createElement("span");
  shield.className = "travel-route-shield";
  shield.textContent = group.roadNumber || "–";
  const copy = document.createElement("span");
  copy.className = "travel-route-title";
  const name = document.createElement("h4");
  name.textContent = group.roadName || "노선 정보 없음";
  const meta = document.createElement("small");
  meta.textContent = `↓ ${origin}에서 출발 · ↑ ${origin}까지 도착`;
  copy.append(name, meta);
  header.append(shield, copy);
  section.append(header);

  if (destinations.length) {
    const summary = document.createElement("p");
    summary.className = "sr-only";
    summary.textContent = destinations.map(destination => {
      const destinationName = destination.name || "목적지";
      return `${origin}에서 ${destinationName} ${formatTravelDuration(destination.outboundSeconds)}, ${destinationName}에서 ${origin} ${formatTravelDuration(destination.inboundSeconds)}`;
    }).join(". ");
    section.append(createTravelVerticalDiagram(group), summary);
  } else {
    const empty = document.createElement("p");
    empty.className = "travel-time-empty";
    empty.textContent = "등록된 대표지역이 없습니다";
    section.append(empty);
  }
  elements.travelGroups.append(section);
  if (focusSelected) {
    elements.travelGroups.scrollTop = 0;
    selectedButton.focus({ preventScroll: true });
  }
}

function updateTravelTimePanel(payload) {
  const groups = Array.isArray(payload.travelCorridors) ? payload.travelCorridors : [];
  state.travelTimes.groups = groups;

  const updated = Number(payload.updatedAt);
  const updatedDate = Number.isFinite(updated) ? new Date(updated * 1000) : null;
  elements.travelUpdated.textContent = updatedDate
    ? updatedDate.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : "--:--";
  if (updatedDate) elements.travelUpdated.dateTime = updatedDate.toISOString();
  else elements.travelUpdated.removeAttribute("datetime");
  elements.travelToggle.disabled = groups.length === 0;
  if (!groups.length) setTravelDrawerOpen(false);
  renderTravelTimeGroups();

  const destinationCount = groups.reduce((total, group) =>
    total + (Array.isArray(group.destinations) ? group.destinations.length : 0), 0);
  elements.travelStatus.textContent = groups.length
    ? `${groups.length}개 노선, ${destinationCount}개 대표지역 이동시간이 갱신되었습니다.`
    : "대표지역 이동시간 정보가 없습니다.";
}

function normalizeRoadQuery(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
}

function listedSeoulRoadName(name) {
  return name === "강남순환도시고속도로" ? "강남순환로" : name;
}

function prepareNetworkPayload(payload) {
  if (payload?.mode !== "seoul" || payload.seoulArterialsPrepared ||
    !Array.isArray(window.SEOUL_ARTERIALS)) return payload;

  const naverByName = new Map();
  payload.roads.forEach(road => naverByName.set(listedSeoulRoadName(road.name), road));
  const usedRoadIds = new Set();
  const baseRoadGeometries = [];
  const roads = window.SEOUL_ARTERIALS.map((arterial, index) => {
    const matched = naverByName.get(arterial.name);
    if (matched) {
      usedRoadIds.add(matched.id);
      return {
        ...matched,
        name: arterial.name,
        listedArterial: true,
        trafficAvailable: true,
        geometryAvailable: true,
      };
    }
    const id = -(index + 1);
    baseRoadGeometries.push({
      roadId: id,
      name: arterial.name,
      components: arterial.components,
    });
    return {
      id,
      number: "간선",
      name: arterial.name,
      kind: "arterialRoad",
      startName: "",
      endName: "",
      edgeCount: 0,
      listedArterial: true,
      trafficAvailable: false,
      geometryAvailable: arterial.components.length > 0,
    };
  });

  payload.roads.forEach(road => {
    if (usedRoadIds.has(road.id)) return;
    roads.push({
      ...road,
      listedArterial: false,
      trafficAvailable: true,
      geometryAvailable: true,
    });
  });
  const displayNameByRoadId = new Map(
    roads.filter(road => road.trafficAvailable).map(road => [road.id, road.name]),
  );
  return {
    ...payload,
    roads,
    edges: payload.edges.map(edge => ({
      ...edge,
      roadName: displayNameByRoadId.get(edge.roadId) || edge.roadName,
    })),
    baseRoadGeometries,
    seoulArterialsPrepared: true,
  };
}

function roadKindLabel(kind) {
  return {
    highway: "고속도로",
    urbanExpressway: "도시화고속도로",
    majorRoad: "주요도로",
    arterialRoad: "주간선도로",
  }[kind] || "도로";
}

function roadMatchesQuery(road, query) {
  const keyword = normalizeRoadQuery(query);
  return !keyword || normalizeRoadQuery(road.name).includes(keyword) ||
    normalizeRoadQuery(road.number).includes(keyword) ||
    normalizeRoadQuery(roadKindLabel(road.kind)).includes(keyword) ||
    normalizeRoadQuery(road.listedArterial ? "주간선도로" : "").includes(keyword) ||
    normalizeRoadQuery(road.trafficAvailable ? "교통정보 있음" : "교통정보 없음 회색").includes(keyword) ||
    normalizeRoadQuery(road.startName).includes(keyword) ||
    normalizeRoadQuery(road.endName).includes(keyword);
}

function renderRoadOptions(roads = state.payload?.roads || []) {
  const visibleRoads = roads.filter(road => roadMatchesQuery(road, state.roadQuery));
  elements.roadList.replaceChildren();
  const appendRoad = road => {
    const label = document.createElement("label");
    label.className = `road-option${road.trafficAvailable === false ? " is-no-traffic" : ""}`;
    const endpoints = road.startName && road.endName ? `${road.startName} ↔ ${road.endName}` : "";
    const status = road.trafficAvailable === false ? "교통정보 없음 · 회색 표시" : endpoints;
    const shield = road.listedArterial && road.kind !== "urbanExpressway"
      ? "간선" : road.number || roadKindLabel(road.kind);
    label.title = status ? `${road.name} · ${status}` : road.name;
    label.innerHTML = `<input type="checkbox" value="${road.id}" aria-label="${escapeHtml(road.name)} 표시" /><span class="route-shield is-${escapeHtml(road.kind || "road")}">${escapeHtml(shield)}</span><span class="road-copy"><span class="road-name">${escapeHtml(road.name)}</span>${status ? `<small class="road-endpoints">${escapeHtml(status)}</small>` : ""}</span>`;
    const input = label.querySelector("input");
    input.checked = state.selectedRoads.has(road.id);
    input.addEventListener("change", event => {
      const id = Number(event.target.value);
      event.target.checked ? state.selectedRoads.add(id) : state.selectedRoads.delete(id);
      state.modeStates[state.mode].selectedRoads = state.selectedRoads;
      renderGraph();
      updateRoadToggleText();
    });
    elements.roadList.append(label);
  };
  if (state.mode === "seoul") {
    [
      [road => road.listedArterial && road.kind === "urbanExpressway", "도시화고속도로"],
      [road => road.listedArterial && road.kind !== "urbanExpressway", "주간선도로"],
      [road => !road.listedArterial, "기타 주요도로"],
    ].forEach(([matches, label]) => {
      const categoryRoads = visibleRoads.filter(matches);
      if (!categoryRoads.length) return;
      const heading = document.createElement("p");
      heading.className = "road-category-title";
      heading.innerHTML = `<span>${label}</span><b>${categoryRoads.length}</b>`;
      elements.roadList.append(heading);
      categoryRoads.forEach(appendRoad);
    });
  } else {
    visibleRoads.forEach(appendRoad);
  }
  if (!visibleRoads.length) {
    const empty = document.createElement("p");
    empty.className = "road-search-empty";
    empty.textContent = "일치하는 노선이 없습니다";
    elements.roadList.append(empty);
  }
  elements.roadSearchStatus.textContent = state.roadQuery
    ? `${roads.length}개 노선 중 ${visibleRoads.length}개 검색됨`
    : `${roads.length}개 노선 표시`;
  elements.clearRoadSearch.hidden = !state.roadQuery;
}

function updateRoadToggleText() {
  const allSelected = state.payload?.roads.every(road => state.selectedRoads.has(road.id));
  elements.toggleRoads.textContent = allSelected ? "전체 해제" : "전체 선택";
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function currentZoom() {
  return BASE_VIEW.width / view.width;
}

function applyViewBox(updateStyles = true) {
  view.x = clamp(view.x, 0, BASE_VIEW.width - view.width);
  view.y = clamp(view.y, 0, BASE_VIEW.height - view.height);
  elements.svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
  elements.zoomReset.textContent = `${Math.round(currentZoom() * 100)}%`;
  if (updateStyles) updateZoomDependentStyles();
}

function updateZoomDependentStyles(recomputePaths = true) {
  const zoom = currentZoom();
  const unit = pixelsToMap();
  if (recomputePaths) {
    pathGeometries.forEach(geometry => {
      geometry.geometry = parallelShape(
        geometry.shape, geometry.screenOffset, geometry.endpointOffset, unit,
        geometry.start, geometry.end,
      );
      geometry.paths.forEach(path => path.setAttribute("d", geometry.geometry.d));
    });
  }
  elements.nodes.querySelectorAll(".node").forEach(node => {
    node.setAttribute("r", NODE_RADIUS_PX * unit);
  });
  layoutLabels(zoom, unit);
}

function zoomBy(scale, clientX, clientY) {
  const anchor = clientX == null
    ? { x: view.x + view.width / 2, y: view.y + view.height / 2 }
    : clientToMapPoint(clientX, clientY);
  const nextWidth = clamp(view.width * scale, BASE_VIEW.width / MAX_ZOOM, BASE_VIEW.width);
  const nextHeight = nextWidth * BASE_VIEW.height / BASE_VIEW.width;
  view.x = anchor.x - (anchor.x - view.x) * nextWidth / view.width;
  view.y = anchor.y - (anchor.y - view.y) * nextHeight / view.height;
  view.width = nextWidth;
  view.height = nextHeight;
  applyViewBox();
}

function resetZoom() {
  Object.assign(view, BASE_VIEW);
  applyViewBox();
}

function modeCopy(mode = state.mode) {
  return mode === "seoul" ? {
    label: "서울",
    panelTitle: "서울 도로 선택",
    searchLabel: "서울 도로 검색",
    searchPlaceholder: "도로명 · 시종점 검색",
    listLabel: "서울 도시화고속도로, 주간선도로 및 기타 주요도로 목록",
    eyebrow: "실시간 서울 네트워크",
    heading: "서울 도시화고속도로 · 주간선도로 흐름",
    graphTitle: "서울 도시화고속도로와 주간선도로 교통 그래프",
    graphDescription: "서울 주간선도로 전체를 표시하고, 네이버 교통정보가 있는 구간은 평균속도별 색상으로, 없는 도로는 회색으로 표시합니다.",
    loadingTitle: "서울 교통 흐름을 불러오는 중입니다",
    loadingCopy: "도시화고속도로와 주간선도로를 연결하고 있어요.",
  } : {
    label: "전국",
    panelTitle: "고속도로 선택",
    searchLabel: "고속도로 노선 검색",
    searchPlaceholder: "노선명 · 번호 검색",
    listLabel: "전국 고속도로 목록",
    eyebrow: "실시간 전국 네트워크",
    heading: "전국 고속도로 흐름",
    graphTitle: "대한민국 주요 고속도로 교통 그래프",
    graphDescription: "주요 분기점을 정점으로, 고속도로 구간을 평균속도별 색상으로 표시합니다.",
    loadingTitle: "전국 교통 흐름을 불러오는 중입니다",
    loadingCopy: "주요 고속도로 구간을 연결하고 있어요.",
  };
}

function updateSpeedScaleUi() {
  const scale = SPEED_SCALES[state.mode] || SPEED_SCALES.national;
  const flowLabels = {
    fast: "원활", normal: "보통", slow: "서행", jam: "정체", critical: "극심",
  };
  document.querySelectorAll("[data-speed-range]").forEach(element => {
    element.textContent = scale.ranges[element.dataset.speedRange] || "";
  });
  document.querySelectorAll("[data-flow]").forEach(button => {
    const flow = button.dataset.flow;
    if (flow === "all") return;
    button.setAttribute("aria-label", `${flowLabels[flow]}, ${scale.ranges[flow]}`);
    button.title = `${flowLabels[flow]} · ${scale.ranges[flow]}`;
  });
  document.querySelector('[data-flow="critical"]').textContent = scale.criticalButton;
}

function updateModeUi() {
  const copy = modeCopy();
  document.querySelectorAll("[data-mode]").forEach(button => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  elements.roadPanelTitle.textContent = copy.panelTitle;
  elements.roadSearchLabel.textContent = copy.searchLabel;
  elements.roadSearch.placeholder = copy.searchPlaceholder;
  elements.roadList.setAttribute("aria-label", copy.listLabel);
  elements.graphEyebrow.textContent = copy.eyebrow;
  elements.graphHeading.textContent = copy.heading;
  elements.graphTitle.textContent = copy.graphTitle;
  elements.graphDescription.textContent = copy.graphDescription;
  updateSpeedScaleUi();
  if (state.mode === "seoul") setTravelDrawerOpen(false);
  elements.travelDrawer.hidden = state.mode === "seoul";
}

function showModeLoading() {
  const copy = modeCopy();
  elements.loading.innerHTML = `<span></span><strong>${escapeHtml(copy.loadingTitle)}</strong><small>${escapeHtml(copy.loadingCopy)}</small>`;
  elements.loading.hidden = false;
}

function persistCurrentModeState() {
  const modeState = state.modeStates[state.mode];
  modeState.payload = state.payload;
  modeState.selectedRoads = new Set(state.selectedRoads);
  modeState.roadQuery = state.roadQuery;
  modeState.view = { ...view };
}

function clearRenderedNetwork() {
  elements.arterials.replaceChildren();
  elements.edges.replaceChildren();
  elements.labels.replaceChildren();
  elements.nodes.replaceChildren();
  elements.empty.hidden = true;
  pathGeometries = [];
  basePathSegments = [];
  labelGeometries = [];
  hideTooltip();
}

function applyNetworkPayload(rawPayload) {
  const payload = prepareNetworkPayload(rawPayload);
  const modeState = state.modeStates[state.mode];
  const previousRoads = modeState.payload?.roads || [];
  const previousSelection = modeState.selectedRoads;
  const previouslyAllSelected = previousRoads.length > 0 &&
    previousRoads.every(road => previousSelection.has(road.id));
  const incomingIds = new Set(payload.roads.map(road => road.id));
  const selectedRoads = !modeState.payload || previouslyAllSelected
    ? new Set(incomingIds)
    : new Set([...previousSelection].filter(id => incomingIds.has(id)));

  modeState.payload = payload;
  modeState.selectedRoads = selectedRoads;
  state.payload = payload;
  state.selectedRoads = selectedRoads;
  configureMapProjection(payload);
  applyViewBox(false);
  renderRoadOptions(payload.roads);
  updateRoadToggleText();
  renderGraph();
  updateTravelTimePanel(payload);
  elements.updatedAt.textContent = new Date(payload.updatedAt * 1000)
    .toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  elements.liveState.lastElementChild.textContent = payload.partial ? "일부 노선 연결" : "실시간 연결됨";
  elements.loading.hidden = true;
  elements.roadSearch.disabled = false;
  elements.toggleRoads.disabled = false;
  elements.scopeStatus.textContent = `${modeCopy().label} ${payload.roads.length}개 도로를 표시했습니다.`;
}

function setMode(mode) {
  if (!state.modeStates[mode] || mode === state.mode) return;
  persistCurrentModeState();
  networkRequestSerial += 1;
  setTravelDrawerOpen(false);
  clearRenderedNetwork();
  state.mode = mode;
  const modeState = state.modeStates[mode];
  state.payload = modeState.payload;
  state.selectedRoads = new Set(modeState.selectedRoads);
  modeState.selectedRoads = state.selectedRoads;
  state.roadQuery = modeState.roadQuery;
  elements.roadSearch.value = state.roadQuery;
  Object.assign(view, modeState.view);
  state.flow = "all";
  document.querySelectorAll("[data-flow]").forEach(button => {
    const active = button.dataset.flow === "all";
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  updateModeUi();

  if (modeState.payload) {
    applyNetworkPayload(modeState.payload);
    loadNetwork(false, false);
  } else {
    mapBounds = mode === "seoul" ? { ...SEOUL_FALLBACK_BOUNDS } : { ...NATIONAL_MAP_BOUNDS };
    renderOutline();
    applyViewBox(false);
    elements.roadList.replaceChildren();
    elements.roadSearch.disabled = true;
    elements.toggleRoads.disabled = true;
    elements.clearRoadSearch.hidden = !state.roadQuery;
    elements.roadSearchStatus.textContent = `${modeCopy().label} 도로를 불러오는 중`;
    updateTravelTimePanel({ travelCorridors: [] });
    showModeLoading();
    loadNetwork();
  }
}

async function loadNetwork(force = false, showLoading = true) {
  const requestMode = state.mode;
  const requestSerial = ++networkRequestSerial;
  if (showLoading) showModeLoading();
  elements.refresh.classList.add("is-loading");
  elements.liveState.classList.remove("is-error");
  elements.liveState.lastElementChild.textContent = "실시간 연결 중";
  try {
    const query = new URLSearchParams({ mode: requestMode });
    if (force) query.set("refresh", "true");
    const response = await fetch(`/api/network?${query}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "교통정보를 불러오지 못했습니다.");
    if (payload.mode && payload.mode !== requestMode) {
      throw new Error("요청한 지도 범위와 다른 교통정보를 받았습니다.");
    }
    if (requestSerial !== networkRequestSerial) return;
    if (requestMode !== state.mode) {
      const modeState = state.modeStates[requestMode];
      if (!modeState.payload) {
        modeState.selectedRoads = new Set(payload.roads.map(road => road.id));
      }
      modeState.payload = payload;
      return;
    }
    applyNetworkPayload(payload);
  } catch (error) {
    if (requestMode !== state.mode || requestSerial !== networkRequestSerial) return;
    if (state.payload) {
      elements.loading.hidden = true;
      elements.liveState.classList.add("is-error");
      elements.liveState.lastElementChild.textContent = "갱신 실패 · 저장 정보 표시";
      elements.scopeStatus.textContent = `${modeCopy().label} 교통정보 갱신에 실패해 저장된 정보를 표시합니다.`;
      return;
    }
    elements.loading.innerHTML = `<strong>교통정보를 불러오지 못했습니다</strong><small>${escapeHtml(error.message)}</small>`;
    elements.liveState.classList.add("is-error");
    elements.liveState.lastElementChild.textContent = "연결 오류";
  } finally {
    if (requestMode === state.mode && requestSerial === networkRequestSerial) {
      elements.refresh.classList.remove("is-loading");
    }
  }
}

document.querySelectorAll("[data-flow]").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll("[data-flow]").forEach(item => {
    const active = item === button;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  state.flow = button.dataset.flow;
  renderGraph();
}));

document.querySelectorAll("[data-mode]").forEach(button => button.addEventListener("click", () => {
  setMode(button.dataset.mode);
}));

elements.toggleRoads.addEventListener("click", () => {
  if (!state.payload) return;
  const allSelected = state.payload.roads.every(road => state.selectedRoads.has(road.id));
  state.selectedRoads = new Set(allSelected ? [] : state.payload.roads.map(road => road.id));
  state.modeStates[state.mode].selectedRoads = state.selectedRoads;
  renderRoadOptions();
  updateRoadToggleText();
  renderGraph();
});

elements.roadSearch.addEventListener("input", event => {
  state.roadQuery = event.target.value;
  state.modeStates[state.mode].roadQuery = state.roadQuery;
  renderRoadOptions();
});

elements.clearRoadSearch.addEventListener("click", () => {
  state.roadQuery = "";
  state.modeStates[state.mode].roadQuery = "";
  elements.roadSearch.value = "";
  renderRoadOptions();
  elements.roadSearch.focus();
});

elements.travelToggle.addEventListener("click", () => {
  setTravelDrawerOpen(!state.travelTimes.open);
});

elements.travelDrawer.addEventListener("pointerenter", scheduleTravelDrawerOpen);
elements.travelDrawer.addEventListener("pointerleave", scheduleTravelDrawerClose);
elements.travelDrawer.addEventListener("focusin", () => {
  if (!elements.travelToggle.disabled) setTravelDrawerOpen(true);
});
elements.travelDrawer.addEventListener("focusout", event => {
  if (event.relatedTarget && elements.travelDrawer.contains(event.relatedTarget)) return;
  window.setTimeout(() => {
    if (!elements.travelDrawer.contains(document.activeElement) &&
      !(travelHoverMedia.matches && elements.travelDrawer.matches(":hover"))) {
      setTravelDrawerOpen(false);
    }
  });
});

document.addEventListener("pointerdown", event => {
  if (!travelHoverMedia.matches && state.travelTimes.open &&
    !elements.travelDrawer.contains(event.target)) {
    setTravelDrawerOpen(false);
  }
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !state.travelTimes.open) return;
  event.preventDefault();
  closeTravelDrawerAndRestoreFocus();
});

elements.refresh.addEventListener("click", () => loadNetwork(true, false));
document.querySelector("#zoom-in").addEventListener("click", () => zoomBy(.78));
document.querySelector("#zoom-out").addEventListener("click", () => zoomBy(1.28));
elements.zoomReset.addEventListener("click", resetZoom);

elements.svg.addEventListener("wheel", event => {
  event.preventDefault();
  zoomBy(event.deltaY > 0 ? 1.16 : .86, event.clientX, event.clientY);
}, { passive: false });

elements.svg.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  panStart = {
    clientX: event.clientX,
    clientY: event.clientY,
    x: view.x,
    y: view.y,
    unit: pixelsToMap(),
  };
  elements.svg.setPointerCapture(event.pointerId);
  elements.svg.classList.add("is-panning");
  hideTooltip();
});

elements.svg.addEventListener("pointermove", event => {
  if (!panStart) return;
  view.x = panStart.x - (event.clientX - panStart.clientX) * panStart.unit;
  view.y = panStart.y - (event.clientY - panStart.clientY) * panStart.unit;
  applyViewBox(false);
});

function finishPan(event) {
  if (!panStart) return;
  if (elements.svg.hasPointerCapture(event.pointerId)) elements.svg.releasePointerCapture(event.pointerId);
  panStart = null;
  elements.svg.classList.remove("is-panning");
  updateZoomDependentStyles();
}

elements.svg.addEventListener("pointerup", finishPan);
elements.svg.addEventListener("pointercancel", finishPan);
elements.svg.addEventListener("dblclick", resetZoom);
window.addEventListener("resize", () => {
  if (state.payload) renderGraph();
  else updateZoomDependentStyles();
});

updateModeUi();
renderOutline();
applyViewBox();
loadNetwork();
