use std::{
    collections::{HashMap, HashSet},
    env,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::{
    sync::{RwLock, Semaphore},
    task::JoinSet,
};

const NAVER_HOME: &str = "https://rtt.map.naver.com/end-traffic/ends/web/home";
const NAVER_API: &str = "https://rtt.map.naver.com/end-traffic/api/traffic-dist/road_cond";
const NAVER_ROAD_CATALOG_API: &str =
    "https://rtt.map.naver.com/end-traffic/api/traffic-dist/road_group";
const CACHE_TTL: Duration = Duration::from_secs(90);
const MAX_CONCURRENT_REQUESTS: usize = 10;
const SEOUL_TRAFFIC_EXTENSION_IDS: [u32; 5] = [10002, 40266, 40976, 60001, 60032];

const CORE_ROADS: &[(u32, &str, &str)] = &[
    (10002, "1", "경부고속도로"),
    (10019, "15", "서해안고속도로"),
    (10020, "50", "영동고속도로"),
    (10047, "35", "중부고속도로"),
    (10029, "45", "중부내륙고속도로"),
    (10031, "55", "중앙고속도로"),
    (10017, "60", "서울양양고속도로"),
    (10036, "25", "호남고속도로"),
    (10006, "10", "남해고속도로"),
    (10001, "12", "광주대구고속도로"),
];

const SEOUL_ROADS: &[(u32, &str, &str, RoadKind)] = &[
    (10002, "1", "경부간선도로", RoadKind::MajorRoad),
    (20003, "70", "강변북로", RoadKind::UrbanExpressway),
    (20007, "30", "내부순환로", RoadKind::UrbanExpressway),
    (20008, "61", "동부간선도로", RoadKind::UrbanExpressway),
    (20011, "44", "북부간선도로", RoadKind::UrbanExpressway),
    (20014, "55", "서부간선도로", RoadKind::UrbanExpressway),
    (20017, "88", "올림픽대로", RoadKind::UrbanExpressway),
    (
        20025,
        "94",
        "강남순환도시고속도로",
        RoadKind::UrbanExpressway,
    ),
    (40026, "주요", "강남대로", RoadKind::MajorRoad),
    (40028, "주요", "강동대로", RoadKind::MajorRoad),
    (40060, "주요", "경인로", RoadKind::MajorRoad),
    (40086, "주요", "공항대로", RoadKind::MajorRoad),
    (40093, "주요", "관악로", RoadKind::MajorRoad),
    (40167, "주요", "남대문로", RoadKind::MajorRoad),
    (40169, "주요", "남부순환로", RoadKind::MajorRoad),
    (40178, "주요", "노들로", RoadKind::MajorRoad),
    (40252, "주요", "도산대로", RoadKind::MajorRoad),
    (40262, "주요", "돈화문로", RoadKind::MajorRoad),
    (40266, "주요", "동일로", RoadKind::MajorRoad),
    (40282, "주요", "동소문로", RoadKind::MajorRoad),
    (40288, "주요", "동작대로", RoadKind::MajorRoad),
    (40382, "주요", "반포대로", RoadKind::MajorRoad),
    (40440, "주요", "봉은사로", RoadKind::MajorRoad),
    (40449, "주요", "북악산로", RoadKind::MajorRoad),
    (40482, "주요", "삼성로", RoadKind::MajorRoad),
    (40484, "주요", "삼일대로", RoadKind::MajorRoad),
    (40504, "주요", "새문안로", RoadKind::MajorRoad),
    (40557, "주요", "성산로", RoadKind::MajorRoad),
    (40570, "주요", "세종대로", RoadKind::MajorRoad),
    (40588, "3", "송파대로", RoadKind::MajorRoad),
    (40620, "주요", "시흥대로", RoadKind::MajorRoad),
    (40662, "주요", "안양천로", RoadKind::MajorRoad),
    (40672, "주요", "양재대로", RoadKind::MajorRoad),
    (40682, "주요", "언주로", RoadKind::MajorRoad),
    (40709, "주요", "영동대로", RoadKind::MajorRoad),
    (40767, "주요", "원효로", RoadKind::MajorRoad),
    (40782, "주요", "율곡로", RoadKind::MajorRoad),
    (40787, "주요", "을지로", RoadKind::MajorRoad),
    (40855, "주요", "국회대로", RoadKind::MajorRoad),
    (40919, "주요", "천호대로", RoadKind::MajorRoad),
    (40924, "주요", "청계천로", RoadKind::MajorRoad),
    (40946, "주요", "충정로", RoadKind::MajorRoad),
    (40969, "주요", "테헤란로", RoadKind::MajorRoad),
    (40976, "주요", "통일로", RoadKind::MajorRoad),
    (40978, "주요", "퇴계로", RoadKind::MajorRoad),
    (41004, "주요", "한강대로", RoadKind::MajorRoad),
    (41032, "주요", "헌릉로", RoadKind::MajorRoad),
    (41047, "주요", "화랑로", RoadKind::MajorRoad),
    (60001, "교량", "가양대교", RoadKind::MajorRoad),
    (60032, "교량", "한강대교", RoadKind::MajorRoad),
];

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum NetworkMode {
    #[default]
    National,
    Seoul,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RoadKind {
    Highway,
    UrbanExpressway,
    MajorRoad,
}

#[derive(Clone, Debug)]
struct RoadSpec {
    id: u32,
    number: String,
    name: String,
    kind: RoadKind,
}

impl RoadSpec {
    fn new(id: u32, number: impl Into<String>, name: impl Into<String>, kind: RoadKind) -> Self {
        Self {
            id,
            number: number.into(),
            name: name.into(),
            kind,
        }
    }
}

#[derive(Clone)]
struct AppState {
    client: Client,
    cache: Arc<RwLock<HashMap<NetworkMode, CachedNetwork>>>,
    request_slots: Arc<Semaphore>,
}

#[derive(Clone)]
struct CachedNetwork {
    stored_at: SystemTime,
    payload: NetworkPayload,
}

#[derive(Debug, Deserialize)]
struct NaverRoadResponse {
    road: NaverRoad,
    #[serde(default)]
    groups: Vec<NaverGroup>,
    #[serde(default)]
    sections: Vec<NaverSection>,
}

#[derive(Debug, Deserialize)]
struct NaverRoadCatalogResponse {
    result: NaverRoadCatalogResult,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NaverRoadCatalogResult {
    #[serde(default)]
    road_list: Vec<NaverRoadBucket>,
}

#[derive(Debug, Deserialize)]
struct NaverRoadBucket {
    #[serde(default)]
    road: Vec<NaverRoadCatalogItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NaverRoadCatalogItem {
    name: String,
    number: u32,
    road_type: String,
    seq: u32,
    #[serde(default)]
    si: Option<String>,
    #[serde(default)]
    si_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NaverRoad {
    id: u32,
    number: u32,
    road_name: String,
    st_point_name: String,
    ed_point_name: String,
    st_goal_area: String,
    ed_goal_area: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NaverGroup {
    st_name: String,
    ed_name: String,
    st_point: GeoPoint,
    ed_point: GeoPoint,
    fwd: NaverTraffic,
    opp: NaverTraffic,
    grp_code: String,
    distance: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NaverSection {
    #[serde(default)]
    st_name: String,
    #[serde(default)]
    ed_name: String,
    st_point: GeoPoint,
    ed_point: GeoPoint,
    grp_code: String,
    #[serde(default)]
    fwd: NaverSectionDirection,
    #[serde(default)]
    opp: NaverSectionDirection,
}

#[derive(Debug, Deserialize, Default)]
struct NaverSectionDirection {
    #[serde(default)]
    traffic: Option<NaverTraffic>,
}

#[derive(Debug, Deserialize)]
struct GeoPoint {
    coordinates: [f64; 2],
}

#[derive(Debug, Deserialize)]
struct NaverTraffic {
    #[serde(default)]
    time: u32,
    #[serde(default)]
    desc: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkPayload {
    mode: NetworkMode,
    updated_at: u64,
    source: &'static str,
    source_url: &'static str,
    cache_seconds: u64,
    live: bool,
    partial: bool,
    failed_roads: Vec<String>,
    roads: Vec<RoadSummary>,
    edges: Vec<Edge>,
    travel_corridors: Vec<TravelCorridor>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoadSummary {
    id: u32,
    number: String,
    name: String,
    kind: RoadKind,
    start_name: String,
    end_name: String,
    edge_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Edge {
    id: String,
    road_id: u32,
    road_number: String,
    road_name: String,
    from: Junction,
    to: Junction,
    shape: Vec<Vec<[f64; 2]>>,
    distance_km: f64,
    down: Direction,
    up: Direction,
    down_label: String,
    up_label: String,
}

#[derive(Clone, Debug, Serialize)]
struct Junction {
    name: String,
    lon: f64,
    lat: f64,
    major: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Direction {
    duration_seconds: u32,
    speed_kmh: Option<f64>,
    upstream_status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TravelCorridor {
    id: &'static str,
    road_number: &'static str,
    road_name: &'static str,
    origin: &'static str,
    destinations: Vec<TravelDestination>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TravelDestination {
    name: &'static str,
    outbound_seconds: Option<u32>,
    inbound_seconds: Option<u32>,
}

#[derive(Clone, Debug)]
struct TravelSection {
    start_name: String,
    end_name: String,
    forward_seconds: u32,
    reverse_seconds: u32,
}

#[derive(Deserialize, Default)]
struct NetworkQuery {
    refresh: Option<bool>,
    #[serde(default)]
    mode: NetworkMode,
}

#[tokio::main]
async fn main() {
    let client = Client::builder()
        .user_agent("Mozilla/5.0 (compatible; KoreaTrafficGraph/0.1)")
        .referer(true)
        .timeout(Duration::from_secs(12))
        .build()
        .expect("HTTP client must be created");

    let state = AppState {
        client,
        cache: Arc::new(RwLock::new(HashMap::new())),
        request_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/styles.css", get(styles))
        .route("/korea-boundary.js", get(korea_boundary))
        .route("/seoul-arterials.js", get(seoul_arterials))
        .route("/app.js", get(script))
        .route("/og.png", get(social_preview))
        .route("/api/network", get(network))
        .route("/health", get(health))
        .with_state(state);

    let port = env::var("PORT").unwrap_or_else(|_| "3000".to_owned());
    let address = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .unwrap_or_else(|error| panic!("{address} 포트를 열 수 없습니다: {error}"));
    println!("대한민국 교통 그래프: http://localhost:{port}");
    axum::serve(listener, app)
        .await
        .expect("server terminated unexpectedly");
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../web/index.html"))
}

async fn styles() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        include_str!("../web/styles.css"),
    )
}

async fn script() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../web/app.js"),
    )
}

async fn seoul_arterials() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../web/seoul-arterials.js"),
    )
}

async fn korea_boundary() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        include_str!("../web/korea-boundary.js"),
    )
}

async fn social_preview() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "image/png")],
        include_bytes!("../web/og.png").as_slice(),
    )
}

async fn health() -> &'static str {
    "ok"
}

async fn network(
    State(state): State<AppState>,
    Query(query): Query<NetworkQuery>,
) -> Result<Json<NetworkPayload>, ApiError> {
    let force_refresh = query.refresh.unwrap_or(false);
    if !force_refresh {
        let cache = state.cache.read().await;
        if let Some(cached) = cache.get(&query.mode)
            && cached.stored_at.elapsed().unwrap_or(CACHE_TTL) < CACHE_TTL
        {
            return Ok(Json(cached.payload.clone()));
        }
    }
    let payload = fetch_network(&state.client, state.request_slots.clone(), query.mode).await?;
    state.cache.write().await.insert(
        query.mode,
        CachedNetwork {
            stored_at: SystemTime::now(),
            payload: payload.clone(),
        },
    );
    Ok(Json(payload))
}

async fn fetch_network(
    client: &Client,
    request_slots: Arc<Semaphore>,
    mode: NetworkMode,
) -> Result<NetworkPayload, ApiError> {
    let (road_specs, catalog_fallback) = fetch_road_specs(client, mode).await;
    let mut requests = JoinSet::new();
    for spec in road_specs.iter().cloned() {
        let client = client.clone();
        let request_slots = request_slots.clone();
        requests.spawn(async move {
            let _permit = request_slots
                .acquire_owned()
                .await
                .expect("request semaphore must stay open");
            let response = client
                .get(format!("{NAVER_API}/{}", spec.id))
                .header(reqwest::header::REFERER, NAVER_HOME)
                .send()
                .await?
                .error_for_status()?
                .json::<NaverRoadResponse>()
                .await?;
            Ok::<_, reqwest::Error>((spec, response))
        });
    }

    let mut roads = Vec::new();
    let mut edges = Vec::new();
    let mut travel_sections_by_road = HashMap::<u32, Vec<TravelSection>>::new();
    while let Some(result) = requests.join_next().await {
        if let Ok(Ok((spec, response))) = result {
            let NaverRoadResponse {
                road,
                mut groups,
                sections,
            } = response;
            groups.retain(|group| include_traffic_group(mode, road.id, &group.grp_code));
            if groups.is_empty() {
                continue;
            }
            let road_name =
                if (mode == NetworkMode::Seoul && road.id == 10002) || road.road_name.is_empty() {
                    spec.name.clone()
                } else {
                    road.road_name.clone()
                };
            let road_number = if road.number == 0 {
                spec.number.clone()
            } else {
                road.number.to_string()
            };
            travel_sections_by_road.insert(
                road.id,
                sections
                    .iter()
                    .map(|section| TravelSection {
                        start_name: section.st_name.clone(),
                        end_name: section.ed_name.clone(),
                        forward_seconds: section
                            .fwd
                            .traffic
                            .as_ref()
                            .map_or(0, |traffic| traffic.time),
                        reverse_seconds: section
                            .opp
                            .traffic
                            .as_ref()
                            .map_or(0, |traffic| traffic.time),
                    })
                    .collect(),
            );
            let mut sections_by_group = HashMap::<String, Vec<NaverSection>>::new();
            for section in sections {
                sections_by_group
                    .entry(section.grp_code.clone())
                    .or_default()
                    .push(section);
            }
            let start_name = groups
                .first()
                .map(|group| group.st_name.clone())
                .unwrap_or_else(|| road.st_point_name.clone());
            let end_name = groups
                .last()
                .map(|group| group.ed_name.clone())
                .unwrap_or_else(|| road.ed_point_name.clone());
            let edge_count = groups.len();
            for group in groups {
                let distance_km = group.distance as f64 / 1000.0;
                let group_sections = sections_by_group
                    .get(&group.grp_code)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                let geometry = resolve_group_geometry(
                    &group.st_name,
                    &group.ed_name,
                    group.st_point.coordinates,
                    group.ed_point.coordinates,
                    group.distance as f64,
                    group_sections,
                );
                edges.push(Edge {
                    id: group.grp_code,
                    road_id: road.id,
                    road_number: road_number.clone(),
                    road_name: road_name.clone(),
                    from: junction(geometry.from_name, geometry.from_point),
                    to: junction(geometry.to_name, geometry.to_point),
                    shape: geometry.components,
                    distance_km: round_one(distance_km),
                    down: direction(distance_km, group.fwd),
                    up: direction(distance_km, group.opp),
                    down_label: road.st_goal_area.clone(),
                    up_label: road.ed_goal_area.clone(),
                });
            }
            roads.push(RoadSummary {
                id: road.id,
                number: road_number,
                name: road_name,
                kind: spec.kind,
                start_name,
                end_name,
                edge_count,
            });
        }
    }

    if roads.is_empty() {
        return Err(ApiError::upstream(
            "네이버 교통정보에서 현재 구간 데이터를 가져오지 못했습니다.",
        ));
    }
    roads.sort_by_key(|road| road.id);
    edges.sort_by(|a, b| a.road_id.cmp(&b.road_id).then(a.id.cmp(&b.id)));
    if mode == NetworkMode::National {
        canonicalize_junctions(&mut edges);
    }
    let travel_corridors = if mode == NetworkMode::National {
        build_travel_corridors(&travel_sections_by_road)
    } else {
        Vec::new()
    };
    let loaded_ids: HashSet<_> = roads.iter().map(|road| road.id).collect();
    let mut failed_roads = road_specs
        .iter()
        .filter(|spec| !loaded_ids.contains(&spec.id))
        .map(|spec| spec.name.clone())
        .collect::<Vec<_>>();
    if catalog_fallback {
        failed_roads.insert(
            0,
            match mode {
                NetworkMode::National => "전체 고속도로 목록",
                NetworkMode::Seoul => "서울 도로 목록",
            }
            .to_owned(),
        );
    }

    Ok(NetworkPayload {
        mode,
        updated_at: unix_now(),
        source: "네이버지도 실시간 교통정보",
        source_url: NAVER_HOME,
        cache_seconds: CACHE_TTL.as_secs(),
        live: true,
        partial: !failed_roads.is_empty(),
        failed_roads,
        roads,
        edges,
        travel_corridors,
    })
}

fn include_traffic_group(mode: NetworkMode, road_id: u32, group_code: &str) -> bool {
    if mode != NetworkMode::Seoul {
        return true;
    }
    match road_id {
        10002 => group_code == "1000201D",
        40266 => group_code != "4026601D",
        _ => true,
    }
}

fn catalog_road_kind(road: &NaverRoadCatalogItem, mode: NetworkMode) -> Option<RoadKind> {
    match mode {
        NetworkMode::National if road.road_type == "HIGHWAY" => Some(RoadKind::Highway),
        NetworkMode::Seoul if SEOUL_TRAFFIC_EXTENSION_IDS.contains(&road.seq) => {
            Some(RoadKind::MajorRoad)
        }
        NetworkMode::Seoul
            if road.si.as_deref() == Some("서울") || road.si_code.as_deref() == Some("11000") =>
        {
            match road.road_type.as_str() {
                "EXPRESSWAY" => Some(RoadKind::UrbanExpressway),
                "ROAD" => Some(RoadKind::MajorRoad),
                _ => None,
            }
        }
        _ => None,
    }
}

fn catalog_road_name(road: &NaverRoadCatalogItem, mode: NetworkMode) -> &str {
    if mode == NetworkMode::Seoul && road.seq == 10002 {
        "경부간선도로"
    } else {
        &road.name
    }
}

fn catalog_road_number(road: &NaverRoadCatalogItem, kind: RoadKind) -> String {
    if road.number > 0 {
        return road.number.to_string();
    }
    match kind {
        RoadKind::Highway => "–",
        RoadKind::UrbanExpressway => "도시",
        RoadKind::MajorRoad => "주요",
    }
    .to_owned()
}

fn fallback_road_specs(mode: NetworkMode) -> Vec<RoadSpec> {
    match mode {
        NetworkMode::National => CORE_ROADS
            .iter()
            .map(|(id, number, name)| RoadSpec::new(*id, *number, *name, RoadKind::Highway))
            .collect(),
        NetworkMode::Seoul => SEOUL_ROADS
            .iter()
            .map(|(id, number, name, kind)| RoadSpec::new(*id, *number, *name, *kind))
            .collect(),
    }
}

async fn fetch_road_specs(client: &Client, mode: NetworkMode) -> (Vec<RoadSpec>, bool) {
    let response = client
        .get(NAVER_ROAD_CATALOG_API)
        .header(reqwest::header::REFERER, NAVER_HOME)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status);

    if let Ok(response) = response
        && let Ok(catalog) = response.json::<NaverRoadCatalogResponse>().await
    {
        let mut roads = catalog
            .result
            .road_list
            .into_iter()
            .flat_map(|bucket| bucket.road)
            .filter_map(|road| {
                if road.seq == 0 {
                    return None;
                }
                let kind = catalog_road_kind(&road, mode)?;
                let number = catalog_road_number(&road, kind);
                let name = catalog_road_name(&road, mode).to_owned();
                Some(RoadSpec::new(road.seq, number, name, kind))
            })
            .collect::<Vec<_>>();
        roads.sort_by_key(|road| road.id);
        roads.dedup_by_key(|road| road.id);
        if !roads.is_empty() {
            return (roads, false);
        }
    }

    (fallback_road_specs(mode), true)
}

type TravelLeg<'a> = (u32, &'a str, &'a str);

fn build_travel_corridors(
    sections_by_road: &HashMap<u32, Vec<TravelSection>>,
) -> Vec<TravelCorridor> {
    vec![
        travel_corridor(
            "gyeongbu",
            "1",
            "경부고속도로",
            "서울",
            sections_by_road,
            &[
                ("천안", &[(10002, "서울톨게이트", "천안IC")]),
                ("청주", &[(10002, "서울톨게이트", "청주IC")]),
                ("대전", &[(10002, "서울톨게이트", "대전IC")]),
                ("대구", &[(10002, "서울톨게이트", "동대구JC")]),
                ("경주", &[(10002, "서울톨게이트", "경주IC")]),
                (
                    "울산",
                    &[
                        (10002, "서울톨게이트", "언양JC"),
                        (10022, "언양JC", "울산IC"),
                    ],
                ),
                ("부산", &[(10002, "서울톨게이트", "부산톨게이트")]),
            ],
        ),
        travel_corridor(
            "west-coast",
            "15",
            "서해안고속도로",
            "서서울",
            sections_by_road,
            &[
                ("당진", &[(10019, "서서울톨게이트", "당진IC")]),
                ("군산", &[(10019, "서서울톨게이트", "군산IC")]),
                ("목포", &[(10019, "서서울톨게이트", "목포톨게이트")]),
            ],
        ),
        travel_corridor(
            "honam",
            "25",
            "호남고속도로",
            "서울",
            sections_by_road,
            &[
                (
                    "공주",
                    &[
                        (10002, "서울톨게이트", "천안JC"),
                        (10033, "천안JC", "남공주IC"),
                    ],
                ),
                (
                    "익산",
                    &[
                        (10002, "서울톨게이트", "천안JC"),
                        (10033, "천안JC", "논산JC"),
                        (10036, "논산JC", "익산IC"),
                    ],
                ),
                (
                    "광주",
                    &[
                        (10002, "서울톨게이트", "천안JC"),
                        (10033, "천안JC", "논산JC"),
                        (10036, "논산JC", "광주톨게이트"),
                    ],
                ),
            ],
        ),
        travel_corridor(
            "suncheon-wanju",
            "27",
            "순천완주고속도로",
            "서울",
            sections_by_road,
            &[
                (
                    "전주",
                    &[
                        (10002, "서울톨게이트", "천안JC"),
                        (10033, "천안JC", "논산JC"),
                        (10036, "논산JC", "익산JC"),
                        (10024, "익산JC", "완주JC"),
                        (10041, "완주JC", "동전주IC"),
                    ],
                ),
                (
                    "순천",
                    &[
                        (10002, "서울톨게이트", "천안JC"),
                        (10033, "천안JC", "논산JC"),
                        (10036, "논산JC", "익산JC"),
                        (10024, "익산JC", "완주JC"),
                        (10041, "완주JC", "동순천IC"),
                    ],
                ),
            ],
        ),
        travel_corridor(
            "jungbu",
            "35",
            "중부고속도로",
            "하남",
            sections_by_road,
            &[
                (
                    "대전",
                    &[(10047, "하남JC", "남이JC"), (10042, "남이JC", "대전IC")],
                ),
                (
                    "진주",
                    &[(10047, "하남JC", "남이JC"), (10042, "남이JC", "서진주IC")],
                ),
                (
                    "통영",
                    &[(10047, "하남JC", "남이JC"), (10042, "남이JC", "통영IC")],
                ),
            ],
        ),
        travel_corridor(
            "jungbu-naeryuk",
            "45",
            "중부내륙고속도로",
            "남양주",
            sections_by_road,
            &[
                (
                    "충주",
                    &[
                        (10017, "남양주톨게이트", "화도IC"),
                        (10075, "화도IC", "양평IC"),
                        (10029, "양평IC", "충주IC"),
                    ],
                ),
                (
                    "상주",
                    &[
                        (10017, "남양주톨게이트", "화도IC"),
                        (10075, "화도IC", "양평IC"),
                        (10029, "양평IC", "상주IC"),
                    ],
                ),
                (
                    "창원",
                    &[
                        (10017, "남양주톨게이트", "화도IC"),
                        (10075, "화도IC", "양평IC"),
                        (10029, "양평IC", "내서JC"),
                    ],
                ),
            ],
        ),
        travel_corridor(
            "yeongdong",
            "50",
            "영동고속도로",
            "서창",
            sections_by_road,
            &[
                ("원주", &[(10020, "서창JC", "원주IC")]),
                ("강릉", &[(10020, "서창JC", "강릉JC")]),
            ],
        ),
        travel_corridor(
            "seoul-yangyang",
            "60",
            "서울양양고속도로",
            "강일",
            sections_by_road,
            &[
                ("춘천", &[(10017, "강일IC", "춘천JC")]),
                ("양양", &[(10017, "강일IC", "양양JC")]),
            ],
        ),
    ]
}

fn travel_corridor(
    id: &'static str,
    road_number: &'static str,
    road_name: &'static str,
    origin: &'static str,
    sections_by_road: &HashMap<u32, Vec<TravelSection>>,
    routes: &[(&'static str, &[TravelLeg<'_>])],
) -> TravelCorridor {
    TravelCorridor {
        id,
        road_number,
        road_name,
        origin,
        destinations: routes
            .iter()
            .map(|(name, legs)| TravelDestination {
                name,
                outbound_seconds: itinerary_duration(sections_by_road, legs, false),
                inbound_seconds: itinerary_duration(sections_by_road, legs, true),
            })
            .collect(),
    }
}

fn itinerary_duration(
    sections_by_road: &HashMap<u32, Vec<TravelSection>>,
    legs: &[TravelLeg<'_>],
    reverse: bool,
) -> Option<u32> {
    let mut total = 0_u32;
    if reverse {
        for &(road_id, start, end) in legs.iter().rev() {
            let sections = sections_by_road.get(&road_id)?;
            total = total.checked_add(section_path_duration(sections, end, start)?)?;
        }
    } else {
        for &(road_id, start, end) in legs {
            let sections = sections_by_road.get(&road_id)?;
            total = total.checked_add(section_path_duration(sections, start, end)?)?;
        }
    }
    Some(total)
}

fn section_path_duration(sections: &[TravelSection], start: &str, end: &str) -> Option<u32> {
    let start_positions = section_boundary_positions(sections, start);
    let end_positions = section_boundary_positions(sections, end);
    start_positions
        .iter()
        .flat_map(|&start_index| {
            end_positions
                .iter()
                .map(move |&end_index| (start_index, end_index))
        })
        .filter_map(|(start_index, end_index)| {
            if start_index == end_index {
                return Some(0);
            }
            let (range_start, range_end, forward) = if start_index < end_index {
                (start_index, end_index, true)
            } else {
                (end_index, start_index, false)
            };
            sections[range_start..range_end]
                .iter()
                .map(|section| {
                    if forward {
                        section.forward_seconds
                    } else {
                        section.reverse_seconds
                    }
                })
                .try_fold(0_u32, |total, seconds| {
                    (seconds > 0)
                        .then_some(seconds)
                        .and_then(|seconds| total.checked_add(seconds))
                })
        })
        .min()
}

fn section_boundary_positions(sections: &[TravelSection], name: &str) -> Vec<usize> {
    let mut positions = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        if section.start_name == name {
            positions.push(index);
        }
        if section.end_name == name {
            positions.push(index + 1);
        }
    }
    positions.sort_unstable();
    positions.dedup();
    positions
}

const SHAPE_JOIN_DISTANCE_METERS: f64 = 250.0;
const SHAPE_DUPLICATE_DISTANCE_METERS: f64 = 20.0;
const SHAPE_ENDPOINT_SNAP_DISTANCE_METERS: f64 = 50.0;
const SHAPE_REPAIR_DISTANCE_METERS: f64 = 2_500.0;

struct GroupGeometry {
    from_name: String,
    to_name: String,
    from_point: [f64; 2],
    to_point: [f64; 2],
    components: Vec<Vec<[f64; 2]>>,
}

fn resolve_group_geometry(
    group_start_name: &str,
    group_end_name: &str,
    group_start: [f64; 2],
    group_end: [f64; 2],
    declared_distance_meters: f64,
    sections: &[NaverSection],
) -> GroupGeometry {
    let mut components = build_shape(group_start, group_end, sections);
    try_bridge_shape_components(
        &mut components,
        group_start,
        group_end,
        declared_distance_meters,
    );

    if components.len() == 1 {
        let first = components[0][0];
        let last = *components[0]
            .last()
            .expect("shape component has an endpoint");
        let direct_anchors = coordinate_distance_meters(group_start, first)
            <= SHAPE_ENDPOINT_SNAP_DISTANCE_METERS
            && coordinate_distance_meters(group_end, last) <= SHAPE_ENDPOINT_SNAP_DISTANCE_METERS;
        let reversed_anchors = coordinate_distance_meters(group_start, last)
            <= SHAPE_ENDPOINT_SNAP_DISTANCE_METERS
            && coordinate_distance_meters(group_end, first) <= SHAPE_ENDPOINT_SNAP_DISTANCE_METERS;

        if direct_anchors || reversed_anchors {
            if reversed_anchors && !direct_anchors {
                components[0].reverse();
            }
            let last_index = components[0].len() - 1;
            components[0][0] = group_start;
            components[0][last_index] = group_end;
            return GroupGeometry {
                from_name: group_start_name.to_owned(),
                to_name: group_end_name.to_owned(),
                from_point: group_start,
                to_point: group_end,
                components,
            };
        }

        let reversed_names = section_coordinate_names_are_reversed(sections);
        let first_label = terminal_section_label(first, sections, reversed_names);
        let last_label = terminal_section_label(last, sections, reversed_names);
        if let (Some(first_label), Some(last_label)) = (first_label, last_label) {
            let (derived_start, derived_end, reverse_shape) =
                match (first_label.is_section_start, last_label.is_section_start) {
                    (true, false) => (first_label, last_label, false),
                    (false, true) => (last_label, first_label, true),
                    _ => {
                        return fallback_group_geometry(
                            group_start_name,
                            group_end_name,
                            group_start,
                            group_end,
                            components,
                        );
                    }
                };
            if derived_start.name != derived_end.name {
                if reverse_shape {
                    components[0].reverse();
                }
                let derived_matches_group =
                    derived_start.name == group_start_name && derived_end.name == group_end_name;
                let derived_reverses_group =
                    derived_start.name == group_end_name && derived_end.name == group_start_name;
                if group_start_name != group_end_name && derived_reverses_group {
                    components[0].reverse();
                }
                if group_start_name == group_end_name
                    || derived_matches_group
                    || derived_reverses_group
                {
                    let from_name = if group_start_name == group_end_name {
                        derived_start.name
                    } else {
                        group_start_name.to_owned()
                    };
                    let to_name = if group_start_name == group_end_name {
                        derived_end.name
                    } else {
                        group_end_name.to_owned()
                    };
                    let from_point = components[0][0];
                    let to_point = *components[0]
                        .last()
                        .expect("shape component has an endpoint");
                    return GroupGeometry {
                        from_name,
                        to_name,
                        from_point,
                        to_point,
                        components,
                    };
                }
            }
        }
    }

    fallback_group_geometry(
        group_start_name,
        group_end_name,
        group_start,
        group_end,
        components,
    )
}

fn fallback_group_geometry(
    group_start_name: &str,
    group_end_name: &str,
    group_start: [f64; 2],
    group_end: [f64; 2],
    components: Vec<Vec<[f64; 2]>>,
) -> GroupGeometry {
    GroupGeometry {
        from_name: group_start_name.to_owned(),
        to_name: group_end_name.to_owned(),
        from_point: group_start,
        to_point: group_end,
        components,
    }
}

struct TerminalSectionLabel {
    name: String,
    is_section_start: bool,
}

fn terminal_section_label(
    terminal: [f64; 2],
    sections: &[NaverSection],
    names_reversed: bool,
) -> Option<TerminalSectionLabel> {
    sections
        .iter()
        .flat_map(|section| {
            let (start_point, end_point) = if names_reversed {
                (section.ed_point.coordinates, section.st_point.coordinates)
            } else {
                (section.st_point.coordinates, section.ed_point.coordinates)
            };
            [
                (&section.st_name, start_point, true),
                (&section.ed_name, end_point, false),
            ]
        })
        .filter(|(name, _, _)| !name.is_empty())
        .map(|(name, point, is_section_start)| {
            (
                coordinate_distance_meters(terminal, point),
                TerminalSectionLabel {
                    name: name.clone(),
                    is_section_start,
                },
            )
        })
        .filter(|(distance, _)| *distance <= SHAPE_ENDPOINT_SNAP_DISTANCE_METERS)
        .min_by(|(first, _), (second, _)| first.total_cmp(second))
        .map(|(_, label)| label)
}

fn section_coordinate_names_are_reversed(sections: &[NaverSection]) -> bool {
    section_name_coordinate_score(sections, true) + 1.0
        < section_name_coordinate_score(sections, false)
}

fn section_name_coordinate_score(sections: &[NaverSection], reversed: bool) -> f64 {
    let mut points_by_name = HashMap::<&str, Vec<[f64; 2]>>::new();
    for section in sections {
        let (start_point, end_point) = if reversed {
            (section.ed_point.coordinates, section.st_point.coordinates)
        } else {
            (section.st_point.coordinates, section.ed_point.coordinates)
        };
        if !section.st_name.is_empty() {
            points_by_name
                .entry(section.st_name.as_str())
                .or_default()
                .push(start_point);
        }
        if !section.ed_name.is_empty() {
            points_by_name
                .entry(section.ed_name.as_str())
                .or_default()
                .push(end_point);
        }
    }
    points_by_name
        .values()
        .map(|points| {
            points
                .iter()
                .skip(1)
                .map(|point| coordinate_distance_meters(points[0], *point))
                .sum::<f64>()
        })
        .sum()
}

fn try_bridge_shape_components(
    components: &mut Vec<Vec<[f64; 2]>>,
    group_start: [f64; 2],
    group_end: [f64; 2],
    declared_distance_meters: f64,
) {
    if components.len() != 2 || declared_distance_meters <= 0.0 {
        return;
    }
    let terminals = [
        components[0][0],
        *components[0].last().unwrap(),
        components[1][0],
        *components[1].last().unwrap(),
    ];
    let nearest_terminal = |point| {
        terminals
            .iter()
            .enumerate()
            .map(|(index, terminal)| (coordinate_distance_meters(point, *terminal), index))
            .min_by(|(first, _), (second, _)| first.total_cmp(second))
            .unwrap()
    };
    let start_anchor = nearest_terminal(group_start);
    let end_anchor = nearest_terminal(group_end);
    if start_anchor.0 <= SHAPE_ENDPOINT_SNAP_DISTANCE_METERS
        && end_anchor.0 <= SHAPE_ENDPOINT_SNAP_DISTANCE_METERS
        && start_anchor.1 != end_anchor.1
    {
        return;
    }

    let first_ends = [components[0][0], *components[0].last().unwrap()];
    let second_ends = [components[1][0], *components[1].last().unwrap()];
    let mut candidates = Vec::with_capacity(4);
    for (first_side, first) in first_ends.iter().enumerate() {
        for (second_side, second) in second_ends.iter().enumerate() {
            candidates.push((
                coordinate_distance_meters(*first, *second),
                first_side,
                second_side,
            ));
        }
    }
    candidates.sort_by(|first, second| first.0.total_cmp(&second.0));
    let (gap, first_side, second_side) = candidates[0];
    let second_best = candidates[1].0;
    let repair_limit = SHAPE_REPAIR_DISTANCE_METERS.min(declared_distance_meters * 0.12);
    let drawn_length = components
        .iter()
        .map(|component| polyline_length_meters(component))
        .sum::<f64>();
    if gap > repair_limit
        || second_best < gap * 2.0
        || second_best < gap + 500.0
        || drawn_length + gap > declared_distance_meters * 1.05
    {
        return;
    }

    let mut first = components.remove(0);
    let mut second = components.remove(0);
    if first_side == 0 {
        first.reverse();
    }
    if second_side == 1 {
        second.reverse();
    }
    if coordinate_distance_meters(*first.last().unwrap(), second[0])
        <= SHAPE_DUPLICATE_DISTANCE_METERS
    {
        second.remove(0);
    }
    first.extend(second);
    components.push(first);
}

fn polyline_length_meters(points: &[[f64; 2]]) -> f64 {
    points
        .windows(2)
        .map(|segment| coordinate_distance_meters(segment[0], segment[1]))
        .sum()
}

fn build_shape(
    group_start: [f64; 2],
    group_end: [f64; 2],
    sections: &[NaverSection],
) -> Vec<Vec<[f64; 2]>> {
    let fallback = || vec![vec![group_start, group_end]];
    if !valid_coordinate(group_start) || !valid_coordinate(group_end) {
        return fallback();
    }

    let mut remaining = sections
        .iter()
        .filter_map(|section| {
            let start = section.st_point.coordinates;
            let end = section.ed_point.coordinates;
            (valid_coordinate(start)
                && valid_coordinate(end)
                && coordinate_distance_meters(start, end) > SHAPE_DUPLICATE_DISTANCE_METERS)
                .then_some((start, end))
        })
        .collect::<Vec<_>>();
    if remaining.is_empty() {
        return fallback();
    }

    let mut components = Vec::new();
    while !remaining.is_empty() {
        let seed_index = remaining
            .iter()
            .enumerate()
            .min_by(|(_, first), (_, second)| {
                endpoint_distance_to(group_start, **first)
                    .total_cmp(&endpoint_distance_to(group_start, **second))
            })
            .map(|(index, _)| index)
            .unwrap_or(0);
        let (mut start, mut end) = remaining.swap_remove(seed_index);
        if coordinate_distance_meters(group_start, end)
            < coordinate_distance_meters(group_start, start)
        {
            std::mem::swap(&mut start, &mut end);
        }
        let mut chain = vec![start, end];

        loop {
            let chain_start = chain[0];
            let chain_end = *chain.last().expect("shape chain has an endpoint");
            let mut best: Option<(f64, usize, u8)> = None;
            for (index, &(candidate_start, candidate_end)) in remaining.iter().enumerate() {
                let options = [
                    (coordinate_distance_meters(chain_end, candidate_start), 0),
                    (coordinate_distance_meters(chain_end, candidate_end), 1),
                    (coordinate_distance_meters(chain_start, candidate_end), 2),
                    (coordinate_distance_meters(chain_start, candidate_start), 3),
                ];
                for (distance, attachment) in options {
                    if distance <= SHAPE_JOIN_DISTANCE_METERS
                        && best.is_none_or(|(known, _, _)| distance < known)
                    {
                        best = Some((distance, index, attachment));
                    }
                }
            }

            let Some((distance, index, attachment)) = best else {
                break;
            };
            let (candidate_start, candidate_end) = remaining.swap_remove(index);
            match attachment {
                0 => {
                    if distance > SHAPE_DUPLICATE_DISTANCE_METERS {
                        chain.push(candidate_start);
                    }
                    chain.push(candidate_end);
                }
                1 => {
                    if distance > SHAPE_DUPLICATE_DISTANCE_METERS {
                        chain.push(candidate_end);
                    }
                    chain.push(candidate_start);
                }
                2 => {
                    let mut prefix = vec![candidate_start];
                    if distance > SHAPE_DUPLICATE_DISTANCE_METERS {
                        prefix.push(candidate_end);
                    }
                    prefix.extend(chain);
                    chain = prefix;
                }
                _ => {
                    let mut prefix = vec![candidate_end];
                    if distance > SHAPE_DUPLICATE_DISTANCE_METERS {
                        prefix.push(candidate_start);
                    }
                    prefix.extend(chain);
                    chain = prefix;
                }
            }
        }

        let forward_score = coordinate_distance_meters(group_start, chain[0])
            + coordinate_distance_meters(group_end, *chain.last().unwrap());
        let reverse_score = coordinate_distance_meters(group_start, *chain.last().unwrap())
            + coordinate_distance_meters(group_end, chain[0]);
        if reverse_score < forward_score {
            chain.reverse();
        }
        deduplicate_shape(&mut chain);
        if chain.len() >= 2 {
            components.push(chain);
        }
    }

    if components.is_empty() {
        return fallback();
    }
    components.sort_by(|first, second| {
        endpoint_distance_to(group_start, (first[0], *first.last().unwrap())).total_cmp(
            &endpoint_distance_to(group_start, (second[0], *second.last().unwrap())),
        )
    });

    if let Some(first) = components.first_mut()
        && coordinate_distance_meters(group_start, first[0]) <= SHAPE_ENDPOINT_SNAP_DISTANCE_METERS
    {
        first[0] = group_start;
    }
    if let Some((index, _)) = components
        .iter()
        .enumerate()
        .min_by(|(_, first), (_, second)| {
            endpoint_distance_to(group_end, (first[0], *first.last().unwrap())).total_cmp(
                &endpoint_distance_to(group_end, (second[0], *second.last().unwrap())),
            )
        })
    {
        let component = &mut components[index];
        let last = component.len() - 1;
        if coordinate_distance_meters(group_end, component[last])
            <= SHAPE_ENDPOINT_SNAP_DISTANCE_METERS
        {
            component[last] = group_end;
        }
    }
    components
}

fn endpoint_distance_to(point: [f64; 2], segment: ([f64; 2], [f64; 2])) -> f64 {
    coordinate_distance_meters(point, segment.0).min(coordinate_distance_meters(point, segment.1))
}

fn deduplicate_shape(points: &mut Vec<[f64; 2]>) {
    let mut deduplicated = Vec::with_capacity(points.len());
    for point in points.drain(..) {
        if deduplicated.last().is_none_or(|previous| {
            coordinate_distance_meters(*previous, point) > SHAPE_DUPLICATE_DISTANCE_METERS
        }) {
            deduplicated.push(point);
        }
    }
    *points = deduplicated;
}

fn valid_coordinate([lon, lat]: [f64; 2]) -> bool {
    lon.is_finite()
        && lat.is_finite()
        && (120.0..=135.0).contains(&lon)
        && (30.0..=42.0).contains(&lat)
}

fn coordinate_distance_meters(first: [f64; 2], second: [f64; 2]) -> f64 {
    let mean_latitude = ((first[1] + second[1]) / 2.0).to_radians();
    let longitude = (first[0] - second[0]) * 111_320.0 * mean_latitude.cos();
    let latitude = (first[1] - second[1]) * 110_540.0;
    longitude.hypot(latitude)
}

const JUNCTION_CLUSTER_DISTANCE_METERS: f64 = 2_500.0;
const JUNCTION_ALIAS_DISTANCE_METERS: f64 = 50.0;

struct JunctionEndpointRecord {
    edge_index: usize,
    is_from: bool,
    point: [f64; 2],
    canonical_name: String,
    base_name: String,
    kind: JunctionKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum JunctionKind {
    Interchange,
    Junction,
    Other,
}

fn canonicalize_junctions(edges: &mut [Edge]) {
    let mut records = Vec::with_capacity(edges.len() * 2);
    for (edge_index, edge) in edges.iter().enumerate() {
        for (is_from, node) in [(true, &edge.from), (false, &edge.to)] {
            let canonical_name = canonical_junction_name(&node.name);
            let (base_name, kind) = junction_base_and_kind(&canonical_name);
            records.push(JunctionEndpointRecord {
                edge_index,
                is_from,
                point: [node.lon, node.lat],
                canonical_name,
                base_name,
                kind,
            });
        }
    }

    let mut parents = (0..records.len()).collect::<Vec<_>>();
    for first in 0..records.len() {
        for second in first + 1..records.len() {
            if records[first].base_name != records[second].base_name {
                continue;
            }
            let same_name = records[first].canonical_name == records[second].canonical_name;
            let interchange_alias = matches!(
                (records[first].kind, records[second].kind),
                (JunctionKind::Interchange, JunctionKind::Junction)
                    | (JunctionKind::Junction, JunctionKind::Interchange)
            );
            let limit = if same_name {
                JUNCTION_CLUSTER_DISTANCE_METERS
            } else if interchange_alias {
                JUNCTION_ALIAS_DISTANCE_METERS
            } else {
                continue;
            };
            if coordinate_distance_meters(records[first].point, records[second].point) <= limit {
                union_roots(&mut parents, first, second);
            }
        }
    }

    let mut clusters = HashMap::<usize, Vec<usize>>::new();
    for index in 0..records.len() {
        let root = find_root(&mut parents, index);
        clusters.entry(root).or_default().push(index);
    }
    for indexes in clusters.values().filter(|indexes| indexes.len() > 1) {
        let medoid = indexes
            .iter()
            .map(|&candidate| {
                let total_distance = indexes
                    .iter()
                    .map(|&other| {
                        coordinate_distance_meters(records[candidate].point, records[other].point)
                    })
                    .sum::<f64>();
                (total_distance, records[candidate].point)
            })
            .min_by(
                |(first_distance, first_point), (second_distance, second_point)| {
                    first_distance
                        .total_cmp(second_distance)
                        .then(first_point[0].total_cmp(&second_point[0]))
                        .then(first_point[1].total_cmp(&second_point[1]))
                },
            )
            .map(|(_, point)| point)
            .expect("junction cluster has a medoid");
        if indexes.iter().any(|&index| {
            coordinate_distance_meters(records[index].point, medoid)
                > JUNCTION_CLUSTER_DISTANCE_METERS
        }) {
            continue;
        }
        for &index in indexes {
            let record = &records[index];
            let edge = &mut edges[record.edge_index];
            if !snap_shape_terminal(&mut edge.shape, record.point, medoid) {
                continue;
            }
            let node = if record.is_from {
                &mut edge.from
            } else {
                &mut edge.to
            };
            node.lon = medoid[0];
            node.lat = medoid[1];
        }
    }
}

fn canonical_junction_name(name: &str) -> String {
    let compact = name
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    if let Some(stem) = compact.strip_suffix("분기점") {
        format!("{stem}JC")
    } else if let Some(stem) = compact.strip_suffix("JCT") {
        format!("{stem}JC")
    } else {
        compact
    }
}

fn junction_base_and_kind(name: &str) -> (String, JunctionKind) {
    if let Some(stem) = name.strip_suffix("JC") {
        (stem.to_owned(), JunctionKind::Junction)
    } else if let Some(stem) = name.strip_suffix("IC") {
        (stem.to_owned(), JunctionKind::Interchange)
    } else {
        (name.to_owned(), JunctionKind::Other)
    }
}

fn find_root(parents: &mut [usize], index: usize) -> usize {
    if parents[index] != index {
        parents[index] = find_root(parents, parents[index]);
    }
    parents[index]
}

fn union_roots(parents: &mut [usize], first: usize, second: usize) {
    let first_root = find_root(parents, first);
    let second_root = find_root(parents, second);
    if first_root != second_root {
        parents[second_root] = first_root;
    }
}

fn snap_shape_terminal(
    components: &mut [Vec<[f64; 2]>],
    old_point: [f64; 2],
    new_point: [f64; 2],
) -> bool {
    let mut closest: Option<(f64, usize, bool)> = None;
    for (component_index, component) in components.iter().enumerate() {
        for (point, is_start) in [
            (component[0], true),
            (
                *component.last().expect("shape component has an endpoint"),
                false,
            ),
        ] {
            let distance = coordinate_distance_meters(old_point, point);
            if closest.is_none_or(|(known, _, _)| distance < known) {
                closest = Some((distance, component_index, is_start));
            }
        }
    }
    let Some((distance, component_index, is_start)) = closest else {
        return false;
    };
    if distance > SHAPE_ENDPOINT_SNAP_DISTANCE_METERS {
        return false;
    }
    let component = &mut components[component_index];
    if is_start {
        component[0] = new_point;
    } else {
        let last = component.len() - 1;
        component[last] = new_point;
    }
    true
}

fn junction(name: String, coordinates: [f64; 2]) -> Junction {
    Junction {
        major: is_major_junction(&name),
        name,
        lon: coordinates[0],
        lat: coordinates[1],
    }
}

fn is_major_junction(name: &str) -> bool {
    name.ends_with("JC")
        || name.ends_with("JCT")
        || name.ends_with("분기점")
        || matches!(
            name,
            "한남IC" | "서울톨게이트" | "양양JC" | "부산" | "서서울톨게이트" | "동해IC"
        )
}

fn direction(distance_km: f64, traffic: NaverTraffic) -> Direction {
    let speed_kmh =
        (traffic.time > 0).then(|| round_one(distance_km / (traffic.time as f64 / 3600.0)));
    Direction {
        duration_seconds: traffic.time,
        speed_kmh,
        upstream_status: traffic.desc,
    }
}

fn round_one(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn upstream(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculates_speed_from_distance_and_duration() {
        let result = direction(
            30.0,
            NaverTraffic {
                time: 1_800,
                desc: "원활".to_owned(),
            },
        );
        assert_eq!(result.speed_kmh, Some(60.0));
    }

    #[test]
    fn marks_junctions_as_major() {
        assert!(is_major_junction("안성JC"));
        assert!(is_major_junction("소흘분기점"));
        assert!(!is_major_junction("수원IC"));
    }

    fn catalog_item(
        road_type: &str,
        city: Option<&str>,
        city_code: Option<&str>,
    ) -> NaverRoadCatalogItem {
        NaverRoadCatalogItem {
            name: "테스트도로".to_owned(),
            number: 0,
            road_type: road_type.to_owned(),
            seq: 1,
            si: city.map(str::to_owned),
            si_code: city_code.map(str::to_owned),
        }
    }

    #[test]
    fn selects_naver_roads_for_each_network_mode() {
        let highway = catalog_item("HIGHWAY", None, None);
        let urban = catalog_item("EXPRESSWAY", Some("서울"), Some("11000"));
        let major = catalog_item("ROAD", Some("서울"), Some("11000"));
        let tunnel = catalog_item("TUNNEL", Some("서울"), Some("11000"));
        let gyeonggi = catalog_item("ROAD", Some("경기"), Some("41000"));
        let mut bridge = catalog_item("LARGE_BRIDGE", Some("서울"), Some("11000"));
        bridge.seq = 60001;
        bridge.name = "가양대교".to_owned();
        let mut extended_gyeonggi = catalog_item("ROAD", Some("경기"), Some("41000"));
        extended_gyeonggi.seq = 40266;
        extended_gyeonggi.name = "동일로".to_owned();

        assert_eq!(
            catalog_road_kind(&highway, NetworkMode::National),
            Some(RoadKind::Highway)
        );
        assert_eq!(catalog_road_kind(&highway, NetworkMode::Seoul), None);
        assert_eq!(
            catalog_road_kind(&urban, NetworkMode::Seoul),
            Some(RoadKind::UrbanExpressway)
        );
        assert_eq!(
            catalog_road_kind(&major, NetworkMode::Seoul),
            Some(RoadKind::MajorRoad)
        );
        assert_eq!(catalog_road_kind(&tunnel, NetworkMode::Seoul), None);
        assert_eq!(catalog_road_kind(&gyeonggi, NetworkMode::Seoul), None);
        assert_eq!(
            catalog_road_kind(&bridge, NetworkMode::Seoul),
            Some(RoadKind::MajorRoad)
        );
        assert_eq!(
            catalog_road_kind(&extended_gyeonggi, NetworkMode::Seoul),
            Some(RoadKind::MajorRoad)
        );

        let mut gyeongbu = catalog_item("HIGHWAY", None, None);
        gyeongbu.seq = 10002;
        gyeongbu.name = "경부고속도로".to_owned();
        assert_eq!(
            catalog_road_kind(&gyeongbu, NetworkMode::Seoul),
            Some(RoadKind::MajorRoad)
        );
        assert_eq!(
            catalog_road_name(&gyeongbu, NetworkMode::Seoul),
            "경부간선도로"
        );
        assert_eq!(
            catalog_road_name(&gyeongbu, NetworkMode::National),
            "경부고속도로"
        );
    }

    #[test]
    fn keeps_complete_seoul_fallback_catalog() {
        let roads = fallback_road_specs(NetworkMode::Seoul);
        assert_eq!(roads.len(), 50);
        assert_eq!(
            roads
                .iter()
                .filter(|road| road.kind == RoadKind::UrbanExpressway)
                .count(),
            7
        );
        assert_eq!(
            roads
                .iter()
                .filter(|road| road.kind == RoadKind::MajorRoad)
                .count(),
            43
        );
        assert!(roads.iter().any(|road| road.name == "경부간선도로"));
        assert!(roads.iter().any(|road| road.name == "가양대교"));
        assert!(roads.iter().any(|road| road.name == "한강대교"));
        assert_eq!(
            catalog_road_number(
                &catalog_item("ROAD", Some("서울"), None),
                RoadKind::MajorRoad
            ),
            "주요"
        );
    }

    #[test]
    fn clips_extended_naver_roads_to_their_seoul_segments() {
        assert!(include_traffic_group(NetworkMode::Seoul, 10002, "1000201D"));
        assert!(!include_traffic_group(
            NetworkMode::Seoul,
            10002,
            "1000202D"
        ));
        assert!(!include_traffic_group(
            NetworkMode::Seoul,
            40266,
            "4026601D"
        ));
        assert!(include_traffic_group(NetworkMode::Seoul, 40266, "4026602D"));
        assert!(include_traffic_group(
            NetworkMode::National,
            10002,
            "1000217D"
        ));
    }

    fn section(start: [f64; 2], end: [f64; 2]) -> NaverSection {
        named_section("", "", start, end)
    }

    fn named_section(
        start_name: &str,
        end_name: &str,
        start: [f64; 2],
        end: [f64; 2],
    ) -> NaverSection {
        NaverSection {
            st_name: start_name.to_owned(),
            ed_name: end_name.to_owned(),
            st_point: GeoPoint { coordinates: start },
            ed_point: GeoPoint { coordinates: end },
            grp_code: "test".to_owned(),
            fwd: NaverSectionDirection::default(),
            opp: NaverSectionDirection::default(),
        }
    }

    fn travel_section(start: &str, end: &str, forward: u32, reverse: u32) -> TravelSection {
        TravelSection {
            start_name: start.to_owned(),
            end_name: end.to_owned(),
            forward_seconds: forward,
            reverse_seconds: reverse,
        }
    }

    #[test]
    fn sums_detail_sections_in_both_directions() {
        let sections = vec![
            travel_section("A", "B", 60, 90),
            travel_section("B", "C", 120, 150),
        ];

        assert_eq!(section_path_duration(&sections, "A", "C"), Some(180));
        assert_eq!(section_path_duration(&sections, "C", "A"), Some(240));
    }

    #[test]
    fn rejects_partial_travel_time_when_a_section_is_missing() {
        let sections = vec![
            travel_section("A", "B", 60, 90),
            travel_section("B", "C", 0, 150),
        ];

        assert_eq!(section_path_duration(&sections, "A", "C"), None);
        assert_eq!(section_path_duration(&sections, "C", "A"), Some(240));
    }

    #[test]
    fn reverses_leg_order_for_inbound_itinerary() {
        let roads = HashMap::from([
            (1, vec![travel_section("A", "B", 60, 90)]),
            (2, vec![travel_section("B", "C", 120, 150)]),
        ]);
        let legs = [(1, "A", "B"), (2, "B", "C")];

        assert_eq!(itinerary_duration(&roads, &legs, false), Some(180));
        assert_eq!(itinerary_duration(&roads, &legs, true), Some(240));
    }

    #[test]
    fn keeps_representative_corridors_in_geographic_order() {
        let corridors = build_travel_corridors(&HashMap::new());
        let names = corridors
            .iter()
            .map(|corridor| {
                corridor
                    .destinations
                    .iter()
                    .map(|destination| destination.name)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        assert_eq!(corridors.len(), 8);
        assert_eq!(names.iter().map(Vec::len).sum::<usize>(), 25);
        assert_eq!(
            names,
            vec![
                vec!["천안", "청주", "대전", "대구", "경주", "울산", "부산"],
                vec!["당진", "군산", "목포"],
                vec!["공주", "익산", "광주"],
                vec!["전주", "순천"],
                vec!["대전", "진주", "통영"],
                vec!["충주", "상주", "창원"],
                vec!["원주", "강릉"],
                vec!["춘천", "양양"],
            ]
        );
    }

    #[test]
    fn orders_detail_sections_into_one_shape() {
        let start = [127.0, 37.0];
        let middle = [127.01, 37.0];
        let end = [127.02, 37.0];
        let shapes = build_shape(start, end, &[section(middle, end), section(start, middle)]);

        assert_eq!(shapes, vec![vec![start, middle, end]]);
    }

    #[test]
    fn keeps_disconnected_detail_sections_as_separate_shapes() {
        let start = [127.0, 37.0];
        let end = [127.2, 37.0];
        let shapes = build_shape(
            start,
            end,
            &[section(start, [127.01, 37.0]), section([127.15, 37.0], end)],
        );

        assert_eq!(shapes.len(), 2);
    }

    #[test]
    fn falls_back_to_group_endpoints_without_sections() {
        let start = [127.0, 37.0];
        let end = [127.2, 37.0];
        assert_eq!(build_shape(start, end, &[]), vec![vec![start, end]]);
    }

    #[test]
    fn repairs_internal_group_anchors_with_reversed_section_coordinates() {
        let actual_start = [127.3523897, 36.7144966];
        let first_middle = [127.4206532, 36.7312871];
        let second_middle = [127.4399639, 36.7420884];
        let actual_end = [127.4608446, 36.7436448];
        let sections = [
            named_section("옥산분기점", "서오창IC", first_middle, actual_start),
            named_section("서오창IC", "신수교", second_middle, first_middle),
            named_section("신수교", "오창분기점", actual_end, second_middle),
        ];

        let result = resolve_group_geometry(
            "옥산분기점",
            "오창분기점",
            first_middle,
            second_middle,
            11_223.0,
            &sections,
        );

        assert_eq!(result.from_name, "옥산분기점");
        assert_eq!(result.to_name, "오창분기점");
        assert_eq!(result.from_point, actual_start);
        assert_eq!(result.to_point, actual_end);
        assert_eq!(
            result.components,
            vec![vec![actual_start, first_middle, second_middle, actual_end]]
        );
    }

    #[test]
    fn repairs_duplicate_group_anchor_and_unique_detail_gap() {
        let dongtan_junction = [127.0880836, 37.1783048];
        let dongtan = [127.1328346, 37.2036191];
        let west_yongin = [127.15211, 37.2378571];
        let west_yongin_junction = [127.1826268, 37.2664908];
        let pogok = [127.2046491, 37.2768912];
        let docheok = [127.3056044, 37.2783395];
        let sections = [
            named_section("동탄IC", "동탄분기점", dongtan, dongtan_junction),
            named_section("도척IC", "포곡IC", docheok, pogok),
            named_section(
                "서용인분기점",
                "서용인IC",
                west_yongin_junction,
                west_yongin,
            ),
            named_section("서용인IC", "동탄IC", west_yongin, dongtan),
        ];

        let result =
            resolve_group_geometry("동탄IC", "동탄IC", dongtan, dongtan, 23_906.0, &sections);

        assert_eq!(result.from_name, "도척IC");
        assert_eq!(result.to_name, "동탄분기점");
        assert_eq!(result.from_point, docheok);
        assert_eq!(result.to_point, dongtan_junction);
        assert_eq!(result.components.len(), 1);
        assert_eq!(
            result.components[0],
            vec![
                docheok,
                pogok,
                west_yongin_junction,
                west_yongin,
                dongtan,
                dongtan_junction
            ]
        );
    }

    fn test_edge(id: &str, from_name: &str, from: [f64; 2], to_name: &str, to: [f64; 2]) -> Edge {
        let traffic = || Direction {
            duration_seconds: 60,
            speed_kmh: Some(60.0),
            upstream_status: "원활".to_owned(),
        };
        Edge {
            id: id.to_owned(),
            road_id: id.parse().unwrap_or_default(),
            road_number: "1".to_owned(),
            road_name: "테스트고속도로".to_owned(),
            from: junction(from_name.to_owned(), from),
            to: junction(to_name.to_owned(), to),
            shape: vec![vec![from, to]],
            distance_km: 1.0,
            down: traffic(),
            up: traffic(),
            down_label: "종점".to_owned(),
            up_label: "기점".to_owned(),
        }
    }

    #[test]
    fn canonicalizes_same_junction_without_detaching_shape() {
        let first = [127.0, 37.0];
        let second = [127.004, 37.0];
        let mut edges = vec![
            test_edge("1", "공통JC", first, "첫종점IC", [127.1, 37.0]),
            test_edge("2", "공통분기점", second, "둘째종점IC", [127.2, 37.0]),
        ];

        canonicalize_junctions(&mut edges);

        let canonical = [edges[0].from.lon, edges[0].from.lat];
        assert_eq!(canonical, [edges[1].from.lon, edges[1].from.lat]);
        assert_eq!(edges[0].shape[0][0], canonical);
        assert_eq!(edges[1].shape[0][0], canonical);
    }
}
