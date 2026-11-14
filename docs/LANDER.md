# Lander track

## 1. What this is

The lander track of the Lunar Landing Site Navigator follows a generic robotic lander from Earth parking orbit through lunar capture to a south-pole site. It combines a trajectory, propellant budget, powered descent, attitude/power timeline, landing checks and contingency decisions. The standalone page is `demo/lander.html`, built by `node tools/build-lander.mjs`; the built page runs offline with bundled data and rendering code, with no network dependencies.

**Status: first working version, 14–15 Nov 2026.**

## 2. Mission phases

Reference run: default vehicle, `mons-mouton`, zero skyline mask and zero site height; search from 2027-01-01 UTC. The picker requests **2027-01-11 19:00 UTC**; orbital phasing moves touchdown to **19:39:35 UTC** (+2,375.4 s). These are model outputs, not a flight prediction or a terrain-cleared landing opportunity. Reproduce the budget and events with:

```sh
node --input-type=module -e "import fs from 'node:fs'; const {createEphemeris}=await import('./demo/src/ephemeris.js'); const {planMission}=await import('./demo/src/lander/mission.js'); const {pickLandingTime}=await import('./demo/src/lander/landing.js'); const eph=createEphemeris(JSON.parse(fs.readFileSync('demo/data/ephemeris.json','utf8'))); const site=JSON.parse(fs.readFileSync('demo/data/sites.json','utf8')).find(s=>s.id==='mons-mouton'); const t=pickLandingTime(eph,site,0,Date.parse('2027-01-01T00:00:00Z')); const p=planMission({eph,site,landingMs:t}); console.log(JSON.stringify({times:p.times,transfer:p.transfer,llo:{...p.llo,normal:undefined},budget:p.budget.phases.map(x=>({id:x.id,dv:x.dvMs,prop:x.propellantKg,m0:x.massBeforeKg,m1:x.massAfterKg,burnS:x.burnS,pub:x.published})),margin:p.budget.marginMs,descent:{dur:p.descent.durationS,dv:p.descent.dvUsedMs,range:p.descent.groundRangeM,td:p.descent.touchdown,events:p.descent.events}},null,1))"
```

Durations below use `plan.phases` boundaries. Descent subphase propellant is the difference of sample masses at the gates; subphase Δv is `Isp × G0 × ln(m0/m1)`. Comparisons come from `budget.js:PUBLISHED` and are approximate, not validation against an identical vehicle.

| Phase | What happens | Δv (m/s, this model) | Published comparison | Propellant (kg) | Duration | Attitude mode |
|---|---|---:|---|---:|---|---|
| Parking orbit (LEO 185 km) | Start after Earth ascent; nominal 1.5 revolutions to TLI centre | 0; launch ascent excluded | Apollo-like parking altitude, Orloff [10] | 0 | 7,818.5 s before TLI starts | `sun-point` |
| TLI (upper stage) | Raise apogee toward lunar distance; separate the upper stage | 3,135.1 | 3,050–3,200 m/s, Orloff [10], approximate | 5,381.32, upper stage | 237.5 s | `burn`, prograde |
| Coast + TCMs | TCM-1: 20 m/s at TLI + 1 day; TCM-2: 10 m/s at LOI − 12 h, inside SOI | 30.0 total for both TCMs | 0–50 m/s is an assumed allowance; Apollo corrections typically a few m/s | 20.93 total | 111.52 h to SOI; TCM full-thrust equivalent 14.6 s | `sun-point`; TCM burn mode not scheduled in this timeline |
| Lunar approach (SOI) | Geocentric ellipse blends into lunar arrival hyperbola | 0 additional; TCM-2 counted above | — | 0 additional | 18.17 h to LOI start | `sun-point` |
| LOI (100 km polar) | Retrograde capture into circular polar orbit | 809.6 | 800–950 m/s, Apollo LOI-1 + LOI-2, Orloff [10], approximate | 495.50 | 345.5 s | `burn` |
| Loiter in low lunar orbit | Checkout and wait for site/plane alignment | 0; station-keeping excluded | — | 0 | 4.1157 days between burn edges; 4.1166 days centre-to-centre | `sun-point` |
| DOI (100 × 15 km) | Lower perilune; geometric plane correction at DOI | 19.5 budget; +0.83 geometric correction not charged | 18–30 m/s, Orloff [10], approximate | 10.41 budget only | 7.3 s | `burn`, retrograde |
| Coast to PDI | Fly half the descent ellipse to perilune | 0 | — | 0 | 3,408.2 s after DOI ends | `sun-point` |
| Braking | Reduce orbital speed; reach 2 km high gate | 1,768.6 | Powered descent comparison is combined below | 720.87 | 652.5 s | `burn`, guidance thrust vector |
| Approach with pitch-over | Steepen thrust toward vertical; translate to target and reach 30 m low gate | 195.8 | Assumed gates; Apollo-inspired guidance [12] | 57.60 | 85.0 s | `descent` |
| Terminal vertical descent | Settle horizontal motion; command −1 m/s vertically | 48.2 | Assumed terminal profile | 13.65 | 29.4 s | `descent` |
| Touchdown | Stop on the site sphere; surface power timeline follows | 0 additional | Limits in §9 | 0 additional | Instant; 2 h surface tail assumed | `surface` |
| **Powered descent subtotal** | PDI → touchdown; 574.35 km ground range | **2,012.7** | **1,850–2,100 m/s**, Bennett [11], approximate | **792.12** | **766.9 s** | — |
| **Lander total** | TCM + LOI + DOI + powered descent | **2,871.7** | — | **1,318.95** | Parking insertion → touchdown: **9.6639 days** | — |
| **Including upper-stage TLI** | Arithmetic sum across two stages; excludes Earth ascent | **6,006.8** | — | **6,700.28** | Same mission interval | — |

Lander capacity is **3,174.5 m/s**. After planned burns and the **assumed 60 m/s reserve**, budget margin is **242.8 m/s**; touchdown mass is **881.05 kg**, including **81.05 kg** remaining propellant. The 0.83 m/s DOI plane correction is currently absent from those mass/budget totals. The budget's powered-descent `burnS = 552.4 s` is a full-thrust equivalent, not its throttled elapsed time of 766.9 s.

The polar orbit plane stays fixed in inertial space in this planner while the Moon turns beneath it. The site crosses that plane twice per sidereal month: alignment can add up to **13.66 days (~13.7 days)** beyond the assumed minimum checkout wait of one day. **NRHO staging, as used by Artemis/Gateway: ⬜ not modelled.**

## 3. Method and frames

| Item | Implementation |
|---|---|
| MCI | Moon-centred inertial, lunar equator as base plane, +z along lunar spin; +x points to Moon-fixed 0° E at `epochMs`, as in `relay.js`. The epoch is the **requested**, not shifted, landing time. Positions are km, velocities km/s; timestamps ending `Ms` are Unix milliseconds. |
| Moon-fixed and local | Rotate MCI by `−MOON_RATE × (tMs − epochMs) / 1000` radians about z. Surface directions use east-positive longitude; azimuth is north through east. `enuAt` gives east/north/up offsets in metres. |
| PD frame | Moon-centred, non-rotating; PDI position on +z, initial downrange +x, crossrange +y. Positions/velocities are **m and m/s**, mass kg. Rotate into MCI and divide position/velocity by 1,000. |
| Transfer | Patched conics: an Earth-centred ellipse in the Moon's orbital plane, then a lunar hyperbola with ephemeris-derived arrival v∞. The drawing interpolates position and velocity between the conics inside SOI; this is not an integrated n-body encounter. |
| Phasing | Solve arrival time for the polar plane to contain the site. Shift requested touchdown by at most about half an LLO revolution so the spacecraft reaches DOI at the required orbital phase. Here the LLO period is 7,067.5 s (117.79 min). |
| DOI plane change | Fold a small plane correction into DOI geometry after the time shift. `dvPlaneMs = 2v sin(Δi/2)` is added to the DOI event label, **not yet to `budget.phases`, burn time or propellant**. The separate budget option `lloPlaneChangeDeg` instead charges a specified change at LOI. |
| Descent guidance | Approach uses `a_c = aT + 12(rT − r)/tgo² − 6(vT + v)/tgo`, following Klumpp (1974), *Automatica* 10, 133–146 [12]. Here `aT = 0`; subtract local gravity to obtain required thrust acceleration, then enforce throttle limits. Braking uses boundary-targeting feedback; terminal descent uses position/velocity feedback. |
| Integration and mass | `dynamics.js` supplies RK4 orbital propagation (default 30 s); `descent.js` uses RK4 (default 0.2 s), mass flow `−T/(Isp G0)`, and integrated thrust Δv. `rocket.js` uses the ideal Tsiolkovsky equation. Mission coast/orbit tracks remain analytic conics rather than these perturbed RK4 trajectories. |

## 4. Gravity and why mascons matter

`dynamics.js:createForceModel` combines point-mass gravity, J2 and rotating C22, with optional Earth/Sun differential third-body accelerations. Earth direction/range and Sun direction come from JPL Horizons [8]; Sun range is approximated as one AU. `constants.js` uses GRAIL GRGM900C [7], PDS file `grail_1001/shadr/gggrx_0900c_sha.tab`, with reference radius **1,738.0 km**:

| Coefficient | Fully normalised value in `constants.js` | Conversion / use |
|---|---:|---|
| C̄20 | −9.0886616361343905 × 10⁻⁵ | J2 = −√5 C̄20 = 2.0322865243 × 10⁻⁴; active in force model |
| C̄22 | 3.46733340854267 × 10⁻⁵ | C22 = √(10/24) C̄22 = 2.2381540912 × 10⁻⁵; active in force model |
| C̄30 | −3.1973529610071702 × 10⁻⁶ | J3 = −√7 C̄30 = 8.4594007885 × 10⁻⁶; constant listed, force term not implemented |

The Moon's gravity is lumpy: mass concentrations ("mascons") under the maria repeatedly change an orbiter's eccentricity and pull its perilune downward. Most unmaintained low lunar orbits are unstable on weeks-to-months timescales. Apollo 16's PFS-2 subsatellite struck the Moon after about **35 days in 1972** (historical comparison supplied for this design; approximate, unverified here). Long-lived low-orbit "frozen" families occur near **27°, 50°, 76° and 86°** inclination (Folta & Quinn 2006, AIAA 2006-6749; Ely 2005, *J. Astronautical Sciences* 53 [13,14]); inclination alone is not a lifetime guarantee. Polar south-pole access orbits therefore need station-keeping planning.

**This implementation has only degree-2 perturbations, plus an unused J3 constant. It does not reproduce mascon-driven decay.** Propagating with the full degree-900 GRAIL field would represent the high-degree gravity responsible for that decay; it is not loaded here. The mission planner itself uses unperturbed conics, and its loiter budget contains no station-keeping allowance.

## 5. Vehicle (all assumed)

Every field below is an assumption for a generic robotic lander, not a real vehicle specification. The page lets the user edit vehicle assumptions; `cleanVehicle` fills missing fields and clamps numeric inputs. Comparisons are those in `vehicle.js` comments, approximate and unverified here; fields without a comparison have none implied.

| Field in `VEHICLE_DEFAULTS` | Value | Unit | Comparison / meaning from code |
|---|---|---|---|
| `name` | Generic robotic lander (assumed) | — | Generic scenario, not a named spacecraft |
| `dryMassKg` | 800 | kg | Structure, avionics, payload, legs; residuals included |
| `propellantKg` | 1,400 | kg | Usable propellant at TLI separation; derived wet mass 2,200 kg vs Nova-C ~1.9 t and HAKUTO-R ~1 t [22] |
| `mainThrustN` | 4,500 | N | Apollo LM descent stage ~45 kN [22] |
| `ispS` | 320 | s | Typical MMH/MON-class assumption; Apollo LM ~311 s [22] |
| `throttleMin` | 0.3 | fraction | Apollo LM comparison 10–60% throttle [22]; assumed floor must permit hover |
| `throttleMax` | 1.0 | fraction | Full assumed engine thrust |
| `arrayPowerW` | 1,200 | W | Unshaded, Sun normal to array, at one AU |
| `arrayTracking` | `one-axis` | mode | Alternative `fixed`; body-mounted panel |
| `batteryWh` | 3,000 | Wh | Assumed Li-ion capacity |
| `batteryMinSoc` | 0.2 | fraction | Minimum allowed charge |
| `loadsW.cruise` | 320 | W | Avionics, heaters, low-rate radio |
| `loadsW.orbit` | 380 | W | Plus star tracker and high-rate radio |
| `loadsW.descent` | 650 | W | Plus valves, altimeter/velocimeter and hazard lidar |
| `loadsW.surface` | 220 | W | Assumed surface load |
| `loadsW.safe` | 180 | W | Heaters and receiver |
| `touchdown.maxVerticalMs` | 2.0 | m/s | Apollo LM 10 ft/s ≈ 3.0 m/s; approximate, check TN D-6850 [15] |
| `touchdown.maxHorizontalMs` | 1.0 | m/s | Apollo LM 4 ft/s ≈ 1.2 m/s; approximate, check TN D-6850 [15] |
| `touchdown.maxSlopeDeg` | 10 | deg | Apollo LM 12°; approximate, check TN D-6850 [15]; robotic 8–15° comparison unverified [22] |
| `reserveDvMs` | 60 | m/s | Held out of planned burns for dispersions |
| `tliStage.dryMassKg` | 3,000 | kg | Assumed launcher upper stage, discarded before lander operations |
| `tliStage.ispS` | 450 | s | LOX/LH2 class; RL10B-2 ~465 s comparison [22] |

## 6. Variable register

- **Status:** ✅ in the engine · 🟡 partial or simplified · ⬜ not yet
- **Source:** *data* (measured product, cite it) · *assumed* (a default the user can change; the UI
  must label it "assumed") · *input* (the user sets it per scenario) · *derived* (computed from other rows)
- **Code:** the module in `demo/src/` that uses the variable (blank = not built yet)

Values below are defaults unless labelled reference-run outputs. ✅ records implementation, not flight qualification; 🟡 identifies an approximation or incomplete integration. Some internal assumed settings are API options rather than page controls.

| Variable | Unit | Source | Status | Code | Notes |
|---|---|---|---|---|---|
| **6.1 Physical constants** | | | | | |
| Standard gravity `G0` | m/s² | data: CGPM 1901, ISO 80000-3 [1] | ✅ | `lander/constants.js` | 9.80665; Isp conversion, not lunar surface gravity |
| `MU_EARTH` | km³/s² | data: IERS Conventions 2010 / WGS-84 (EGM96) [4] | ✅ | `lander/constants.js` | 398600.4418 |
| `R_EARTH` | km | data: WGS-84 equatorial radius [4] | ✅ | `lander/constants.js` | 6378.137 |
| `MU_SUN` | km³/s² | data: IAU 2009 / JPL DE430 [5] | ✅ | `lander/constants.js` | 1.32712440018 × 10¹¹ |
| `AU_KM` | km | data: IAU 2012 Resolution B2 [2] | ✅ | `lander/constants.js` | 149597870.7 |
| `SOLAR_CONSTANT_W_M2` | W/m² | data: Kopp & Lean 2011 [3] | 🟡 | `lander/constants.js` | 1361 at one AU; listed, array calculation uses its W rating instead |
| `MU_MOON` | km³/s² | data: shared task-book value / DE430 [5] | ✅ | `lander/constants.js`, `relay.js` | 4902.800066; GRGM900C's own GM is 4902.79997, not substituted |
| `R_MOON` | km | data: IAU mean radius [6] | ✅ | `lander/constants.js`, `geometry.js` | 1737.4; shared site sphere |
| `G_MOON_SURFACE` | m/s² | derived: MU_MOON / R_MOON² | ✅ | `lander/constants.js` | 1.6242188593 after km → m conversion |
| `SIDEREAL_MONTH_S`, `MOON_RATE` | s, rad/s | data: shared `relay.js` sidereal month; rate derived | ✅ | `lander/constants.js`, `relay.js` | 27.321661 days = 2360591.5104 s; rate 2.6616995272 × 10⁻⁶ rad/s |
| `EARTH_MOON_MEAN_KM` | km | data: NASA Moon fact sheet [6] | ✅ | `lander/constants.js` | 384400; used for SOI and standalone TLI budget |
| `DEG`, `RAD`, `DAY_S` | deg/rad, rad/deg, s | derived: unit conversions | ✅ | `lander/constants.js` | 180/π, π/180, 86400 |
| **6.2 Gravity field** | | | | | |
| `R_MOON_GRAV` | km | data: GRAIL GRGM900C, Lemoine et al. 2014 [7] | ✅ | `lander/constants.js`, `lander/dynamics.js` | 1738.0 reference radius, not the site sphere |
| `C20N_MOON`, `J2_MOON` | dimensionless | data: GRAIL GRGM900C [7]; J2 derived | ✅ | `lander/constants.js`, `lander/dynamics.js` | Normalised value and conversion in §4 |
| `C22N_MOON`, `C22_MOON` | dimensionless | data: GRAIL GRGM900C [7]; conversion derived | ✅ | `lander/constants.js`, `lander/dynamics.js` | Evaluate C22 in rotating Moon-fixed frame |
| `C30N_MOON`, `J3_MOON` | dimensionless | data: GRAIL GRGM900C [7]; J3 derived | 🟡 | `lander/constants.js` | Constants only; J3 acceleration ⬜ |
| `J2_EARTH` | dimensionless | data: WGS-84 (EGM96) [4] | 🟡 | `lander/constants.js` | 1.08262668 × 10⁻³; listed, not propagated in mission |
| Third-body forces / `j2`, `c22`, `earth`, `sun` switches | km/s², boolean | derived: gravity terms + JPL Horizons [8] | 🟡 | `lander/dynamics.js` | All switches default true; Earth/Sun need ephemeris; Sun range assumed one AU; separate from mission conics |
| RK4 `stepS`, `sampleEveryS` | s | assumed: numerical setting in code | ✅ | `lander/dynamics.js` | 30 s default step; sample interval defaults to step; no accuracy guarantee |
| Full field / mascon decay / station-keeping | km, m/s | data: GRAIL [7], Folta & Quinn [13], Ely [14] | ⬜ | | Degree-900 propagation and station-keeping budget absent |
| **6.3 Trajectory and orbits** | | | | | |
| Lunar SOI `MOON_SOI_KM` | km | derived: Laplace SOI, mean distance and GM ratio | 🟡 | `lander/constants.js` | a(MU_MOON/MU_EARTH)^(2/5) = 66182.9 |
| `leoAltKm`, `parkingRevs` | km, revolutions | assumed: Apollo-like profile; Orloff 2000 [10] | ✅ | `lander/mission.js`, `lander/orbits.js` | 185 km; 1.5 rev; no launch ascent |
| TLI `dvMs`, stage propellant | m/s, kg | derived: vis-viva and rocket equation | 🟡 | `lander/budget.js`, `lander/orbits.js` | Reference 3135.1 m/s; budget always uses mean lunar distance, not mission's dated apogee |
| `apogeeFactor`, transfer apogee | ratio, km | assumed: factor 1.0; distance derived from JPL Horizons [8] | 🟡 | `lander/mission.js` | Hohmann-like; reference apogee radius 406572.7 km, geocentric |
| Transfer TOF, arrival `vInfKms` | s, km/s | derived: conic and JPL Horizons velocity [8] | 🟡 | `lander/mission.js` | Reference 467170.4 s (5.407 days), 0.794975 km/s; standalone budget assumes 0.83 km/s |
| `tliThrustN`, TLI duration | N, s | assumed: RL10-class ~100 kN [22]; duration derived | 🟡 | `lander/mission.js` | 100000 N sets 237.5 s burn display; trajectory uses an impulse |
| TCM sizes and epochs | m/s, s | assumed: `MISSION_DEFAULTS` | 🟡 | `lander/mission.js`, `lander/budget.js` | `tcm1DvMs` 20, `tcm2DvMs` 10; `tcm1AfterTliS` 86400, `tcm2BeforeLoiS` 43200; fuel charged, path not corrected; mass ramps 30/15 s are display assumptions |
| `lloAltKm`, `lloSense`, LLO period | km, sign, s | assumed: 100 km polar orbit; Apollo/Chandrayaan comparisons approximate | 🟡 | `lander/mission.js` | Sense +1 (alternative −1); 90° polar; period derived 7067.5 s; point-mass track |
| `pdiAltKm`, descent ellipse | km | assumed: Apollo DOI perilune ~15 km comparison | ✅ | `lander/mission.js`, `lander/descent.js` | 15 km; nominal 100 × 15 km ellipse |
| `minLoiterDays`, actual loiter | days | assumed: one-day checkout; alignment derived | ✅ | `lander/mission.js` | Reference 4.1166 days LOI-centre → DOI-centre; extra plane wait up to half sidereal month |
| `landingMs`, `landingShiftS`, `epochMs` | UTC ms, s | input: requested time; shift derived | ✅ | `lander/mission.js` | Epoch remains requested time; shift within about ±half LLO period; reference +2375.4 s |
| DOI `dvPlaneMs`; `lloPlaneChangeDeg` | m/s, deg | derived: plane geometry; assumed budget option 0° | 🟡 | `lander/mission.js`, `lander/budget.js` | 0.8283 m/s geometric DOI correction uncharged; separate nonzero budget option adds LOI plane change |
| `site`, `siteHeightKm`, `mask` | deg, km, deg by azimuth | input: site; data: LOLA DEM/skyline [9] when supplied | 🟡 | `lander/mission.js`, `lander/landing.js` | Default height/mask 0; reference run therefore has no actual terrain clearance |
| High gate | m, m/s | assumed: Apollo P64-inspired, not Apollo data | ✅ | `lander/descent.js` | Altitude 2000; horizontal 70; vertical −45 |
| Low gate | m, m/s | assumed: descent guidance boundaries | ✅ | `lander/descent.js` | Altitude 30; horizontal 0.5; vertical −1.5 |
| `approachRangeM`, `approachS`, terminal descent rate | m, s, m/s | assumed: throttle-compatible approach | ✅ | `lander/descent.js` | 3000 m, 85 s, then −1 m/s |
| Descent `massKg`, `dtS` | kg, s | input: PDI mass; assumed fallback and numerical step | ✅ | `lander/descent.js` | Mission supplies post-burn mass; standalone null uses wet mass after assumed 880 m/s; RK4 0.2 s |
| `thrustScale`, `hoverS`, `divert`, `abortAtS`, `coastAfterAbortS` | ratio, s, m | assumed: nominal descent / input: branch scenario | ✅ | `lander/descent.js` | Defaults 1, 0, null, null, 1200 s; hover at 10 m; divert `{atS,crossrangeM,downrangeM}` time is since approach; abort time since PDI |
| Braking margin and guidance limits | fraction, s | assumed: descent planning settings | ✅ | `lander/descent.js` | 0.925 peak-thrust factor; 1800 s brake search, 7200 s powered stop; 0.5 s tgo floor; divert extension ≤30 s |
| `PHASES`, `landedTailS` | phase IDs, s | assumed: mission timeline layout | ✅ | `lander/mission.js` | Twelve contiguous phases (§2); 7200 s after touchdown |
| NRHO staging | — | input: Artemis/Gateway alternative [23] | ⬜ | | No NRHO trajectory or budget |
| **6.4 Vehicle and propulsion** | | | | | |
| `VEHICLE_DEFAULTS.name`, dry / usable / wet mass | —, kg | assumed: generic lander; Nova-C/HAKUTO-R comparisons [22] | ✅ | `lander/vehicle.js` | Name and every field in §5; dry 800, usable 1400, wet derived 2200 |
| Vacuum `ispS`, `mainThrustN`, throttle bounds | s, N, fraction | assumed: Apollo LM / MMH-MON comparison [22] | ✅ | `lander/vehicle.js`, `lander/descent.js` | 320 s, 4500 N, 0.3–1; constant Isp, mass flow from thrust |
| `reserveDvMs`, capacity, margin, propellant left | m/s, kg | assumed: 60 m/s reserve; remainder derived | ✅ | `lander/budget.js`, `lander/rocket.js` | margin = capacity − planned lander Δv − reserve; negative means infeasible |
| `tliStage.dryMassKg`, `tliStage.ispS` | kg, s | assumed: LOX/LH2 class; RL10B-2 comparison [22] | ✅ | `lander/vehicle.js`, `lander/budget.js` | 3000 kg, 450 s; lander does not pay TLI propellant |
| `pdMs`, `tcmMs`, `PUBLISHED` | m/s | assumed: standalone PD 1950, TCM 30; data: approximate Orloff/Bennett comparisons [10,11] | 🟡 | `lander/budget.js` | Mission replaces PD placeholder with simulated Δv; comparison ranges in §2 |
| **6.5 Attitude and power** | | | | | |
| `ATTITUDE_MODES`, body / antenna pointing | mode | assumed: free roll, unconstraining two-axis antenna | 🟡 | `lander/power.js`, `lander/power-timeline.js` | `sun-point`, `burn`, `descent`, `surface`, `safe`; body +Z thrust; no slew or antenna-limit costs |
| `arrayPowerW`, `arrayTracking`, incidence factor | W, mode, fraction | assumed: vehicle rating/tracking; geometry derived | 🟡 | `lander/vehicle.js`, `lander/power.js` | 1200 W, `one-axis` or `fixed`; burn incidence √(1 − (Sun·thrust)²); surface uses local azimuth/elevation |
| `panelAzDeg`, `sunDistanceKm`, `degradation`, `lit` | deg, km, fraction, boolean | assumed: panel faces touchdown Sun, one AU, degradation 1; lighting derived | 🟡 | `lander/power.js`, `lander/power-timeline.js` | Helper panel azimuth defaults 0°; timeline overrides it; power ∝ distance⁻²; geometry inputs can override |
| `batteryWh`, `batteryMinSoc`, `initialSoc` | Wh, fraction | assumed: ideal battery and initial full charge | 🟡 | `lander/vehicle.js`, `lander/power.js`, `lander/power-timeline.js` | 3000 Wh, minimum 0.2, initial 1; integrate net W, clip SOC to [0,1] |
| Loads per mode `loadsW` | W | assumed: vehicle loads | 🟡 | `lander/vehicle.js`, `lander/power.js` | Cruise 320, orbit 380, descent 650, surface 220, safe 180; `burn` (including braking) currently uses orbit load |
| Eclipse, beta angle, eclipse fraction | boolean, rad, fraction | derived: cylindrical shadow; Wertz & Larson [16] | 🟡 | `lander/power.js`, `lander/mission.js` | Moon/Earth parallel-ray shadows, no penumbra; beta from orbit normal and Sun direction |
| Sun / Earth direction and Earth range | unit vector, km | data: JPL Horizons [8] | ✅ | `ephemeris.js`, `lander/mission.js` | Interpolated Moon-fixed directions, rotated to MCI |
| Earth occultation / surface visibility | boolean, deg | derived: sphere intersection / JPL + LOLA skyline [8,9] | 🟡 | `lander/mission.js`, `lander/landing.js` | Far-side passes blocked; mission uses R_MOON − 0.5 km sphere tolerance; surface checks local skyline, no RF link budget |
| **6.6 Environment and risks** | | | | | |
| `gruenFlux(mG)` | g, m⁻² s⁻¹ | data: Grün et al. 1985, tumbling-plate fit at one AU [17] | 🟡 | `lander/environment.js` | Cumulative flux for masses ≥mG; coefficients/exponents transcribed in code |
| Grain diameter / `densityGcm3` | cm, g/cm³ | assumed: spherical grain density 2.5 | 🟡 | `lander/environment.js` | `particleMassG = π d³ ρ / 6`; not a damage threshold |
| MMOD `areaM2`, `durationS`, `minMassG`, `shielding` | m², s, g, fraction | input: exposure; assumed, approximate lunar shielding | 🟡 | `lander/environment.js` | Default shielding 0.5, free space 1; no extra 4π multiplier; example §7 |
| Expected impacts / probability | count, fraction | derived: flux × area × time × shielding; assumed Poisson arrivals | 🟡 | `lander/environment.js` | P(≥1) = 1 − exp(−N); impacts are not necessarily failures |
| `SPACE_WEATHER`, NOAA S-scale | pfu, events/11-year cycle | data: NOAA SWPC [18] | ✅ | `lander/environment.js` | ≥10 MeV proton flux thresholds S1–S5: 10, 100, 1000, 10000, 100000 pfu; average frequencies 50, 25, 10, 3, <1 |
| `CME_TRANSIT_DAYS` | days | data: NOAA SWPC; approximate planning values [18] | 🟡 | `lander/environment.js` | Fast 1, typical 3, slow 4; NOAA range ~15 h to several days, not a forecast |
| `ORBITAL_DEBRIS.leo` | qualitative | assumed: 185 km, 1–3 h parking; NASA ORDEM 3.1 [19] | ⬜ | `lander/environment.js` | COLA screening described; impact probability not computed |
| `ORBITAL_DEBRIS.lunar` | spacecraft count, qualitative | assumed: approximate, unverified inventory; ISRO event [20] | 🟡 | `lander/environment.js` | Of order ten active lunar-region craft; conjunction example 18 Oct 2021; probability not computed |
| `EXOSPHERE.surfaceNightNumberDensityPerCm3` | cm⁻³ | data: Apollo 17 LACE, approximate [21] | 🟡 | `lander/environment.js` | ~10⁵ at night; no measurable mission drag modelled |
| **6.7 Landing constraints** | | | | | |
| Vertical / horizontal touchdown speed limits | m/s | assumed: stricter than Apollo LM; approximate, check TN D-6850 [15] | ✅ | `lander/vehicle.js`, `lander/landing.js` | Absolute vertical ≤2; horizontal ≤1; reference 1.0000 and 0.0014 m/s |
| `maxSlopeDeg`, `stepKm`, DEM sampler | deg, km, m | assumed: 10° limit; data: LOLA DEM [9] | 🟡 | `lander/landing.js` | Default step 0.12 km; 20–120 m DEM sampling baseline; opposite central samples span twice the step; no rocks |
| View `PATCH_HALF_M`, terrain mesh / slope overlay | m, grid divisions, deg | assumed: drawing settings; data: LOLA heights [9] | 🟡 | `lander/view-surface.js` | Half-width 8000 m, 320 divisions (derived 50 m mesh spacing); overlay uses vehicle slope limit; drawing grid is not DEM resolution or collision dynamics |
| Sun and Earth clearance over skyline | deg | derived: JPL Horizons + LOLA skyline [8,9] | ✅ | `lander/landing.js` | Both >0 at actual touchdown; missing DEM/ephemeris is not a passed measurement |
| Picker `stepMs`, `holdMs`, `clearDeg`, `maxDays` | ms, deg, days | assumed: landing-time search settings | 🟡 | `lander/landing.js` | Hourly samples; 48 h hold; >0.3° clearance; search horizon 150 days; rescreen shifted touchdown |
| **6.8 Contingency decisions** | | | | | |
| `EVENTS`, `ACTIONS`, phase, `tSincePdiS` | IDs, s | input: event/state; assumed: operational rules | 🟡 | `lander/contingency.js` | Eight events; rule outputs action, reason, Δv estimate, delay and branch key (§8), not autonomous control |
| Remaining / to-go / reserve Δv | m/s | input: telemetry/budget; assumed reserve 60 | 🟡 | `lander/contingency.js` | margin = `dvRemainingMs − dvToGoMs − reserveDvMs`; no proven spare Δv when missing |
| `divertBudgetMs`, `hazardDistanceM`, `approachTimeLeftS` | m/s, m, s | assumed: 60 m/s divert allocation; input: hazard/time | 🟡 | `lander/contingency.js` | Δv = 4d/t; reachable d = budget × t / 4; lateral allocation is not automatically checked against fuel |
| Divert gravity / extra hover cost | m/s², s | derived: lunar gravity; assumed zero extra hover | 🟡 | `lander/contingency.js` | `gMs2` defaults to G_MOON_SURFACE but adds no cost when extra time is zero; simulation can extend approach ≤30 s |
| Retarget `crossrangeKm`, orbital speed/radius, alternates | km, km/s, site IDs | input: alternate sites; derived: circular plane-change estimate | 🟡 | `lander/contingency.js` | Δv = 2000v sin(crossrange/(2r)); choose nearest affordable alternate, with visibility flags for illumination no-go |
| `orbitPeriodS`, `nextPlaneWindowS`, `altitudeM` | s, m | input: orbit/window; assumed fallback altitude 100000 | 🟡 | `lander/contingency.js` | Default period derived; hold/wave-off one revolution (117.79 min at 100 km); site/visibility holds use next plane window |
| `stormLevel`, CME arrival/window times | S-level, s from same now | input: alert/forecast; assumed S3 gate and S2 hold hysteresis | 🟡 | `lander/contingency.js` | Existing hold releases below S2; CME overlap or unknown timing blocks new PDI |
| `conjunctionMissKm`, avoidance Δv | km, m/s | input: miss distance; assumed threshold and approximate impulse | 🟡 | `lander/contingency.js` | Miss <1 km → 0.5 m/s; no collision-probability calculation |
| Abort recovery thresholds | km, m/s | assumed: descent abort steering | 🟡 | `lander/descent.js` | Bound orbit with perilune ≥15 km, apolune ≥30 km; target climb 15 m/s below safe altitude; success depends on fuel/thrust |

## 7. Environment and risks

| Risk | Where it matters | Model here | Honest note |
|---|---|---|---|
| No atmosphere; tenuous exosphere | Lunar orbit/descent | No lunar drag; approximate nighttime density ~10⁵ cm⁻³ from Apollo 17 LACE [21] | No parachutes or aerodynamic braking; no atmospheric weather model |
| Solar particle events | Coast, LLO, descent, surface | NOAA S-scale from ≥10 MeV proton flux [18]; S3 operational trigger | No live alerts, shielding-dose or electronics-failure prediction |
| CMEs | Timing of commitment to descent | Approximate 1/3/4-day transit values; compare input arrival forecast to window [18] | CME travel time is not the same as energetic-particle arrival or a site forecast |
| Micrometeoroids | Cruise and LLO loiter | Grün 1985 cumulative flux, assumed exposure/shielding, Poisson arrivals [17] | Counts impacts above a mass threshold, not penetration or loss of mission |
| Earth orbital debris | Short LEO parking dwell | COLA and NASA ORDEM 3.1 identified [19] | Impact probability **not computed**; the qualitative low-risk claim is an assumption |
| Lunar orbit traffic | LLO and transfers | ~10 active lunar-region spacecraft, approximate/unverified; individual conjunction concern | No live catalogue or probability; Chandrayaan-2 manoeuvred to avoid LRO on **18 Oct 2021**, per ISRO [20] |
| Communications loss | Far-side LLO passes; Earth below site skyline | Lunar occultation and terrain-horizon checks; GO before PDI | Autonomous descent after PDI assumed; no relay scheduling or RF budget |
| Engine underperformance | Burns, especially braking | `thrustScale` changes descent thrust; reserve-margin rule can request abort | A decision to abort does not prove orbit recovery; actual branch must integrate successfully |
| Hazard at site | Before DOI and during approach | DEM slope check; input hazard triggers retarget/divert | No automatic rock detection; lidar/LROC NAC data needed for lander-scale hazards |

**Worked MMOD exposure (reference run):** `gruenFlux(1e-6) = 4.71515 × 10⁻⁸ m⁻² s⁻¹` for particles ≥10⁻⁶ g. On an **assumed 10 m²** tumbling-plate area over the **355,673.4 s** centre-to-centre LLO loiter, with the **assumed 0.5** lunar shielding factor, `expectedImpacts = flux × 10 × 355673.4 × 0.5 = 0.08385`. `poissonAtLeastOne` gives **0.08043 (8.04%)** for at least one such impact, not for damage. No extra solid-angle factor is applied.

## 8. Contingency plans

Rules below are `contingency.js:decide`; branch keys from `planBranches` are recommendations, not propagated trajectories. The page's three trajectory illustrations are **abort to orbit during braking**, **hazard divert during approach**, and **wave-off one revolution**. Abort/divert dynamics are provided by `simulateDescent`; a wave-off requires a new landing-window and fuel/power check.

| Event | Phase | Decision rule | Action | Δv / delay cost |
|---|---|---|---|---|
| Solar particle event | Pre-PDI lunar orbit | New storm ≥S3; an existing hold persists at S2 | Sun-pointing safe hold until below S2 | No manoeuvre charged; reassess each orbit |
| Solar particle event | Coast / landed; or committed descent | Storm exceeds phase threshold | Safe mode on coast/surface; finish autonomous descent once committed | No computed Δv or clearance-time prediction |
| CME warning | Before PDI | Forecast overlaps landing window, or timing unknown | Hold; continue if overlap ruled out | One orbit to reassessment; committed descent continues |
| Missing ground GO / comms loss | Before PDI / after PDI / landed | No GO before commitment | Wave-off one rev / continue autonomously / surface safe mode | 0 incremental Δv in rule; one LLO rev ≈7067.5 s before retry |
| Engine underperformance | Braking | Remaining Δv − descent-to-go − reserve <0 | Attempt abort to orbit; otherwise extend braking | Rule does not compute abort/longer-burn cost; use integrated branch fuel |
| Engine underperformance | Before PDI / after high gate | Reassess before commitment; do not command late orbital abort | Hold / land at best reachable spot | One orbit pre-PDI; post-PDI cost not computed by rule |
| Site hazard | Before PDI | Nearest alternate plane change fits margin after reserve | Retarget; otherwise wait for next plane window | `2000v sin(crossrange/(2r))` m/s; hold delay = next window |
| Site hazard | Approach / terminal | `4d/t` fits assumed divert allocation and time remains | Divert; otherwise best patch within `budget × t / 4` | Assumed example 150 m in 40 s → 15 m/s; default allocation 60 m/s; rule adds no hover delay |
| Micrometeoroid strike | Any applicable phase | Impact-related anomaly | Safe mode, diagnose, then hold | One-orbit reassessment in orbital phases; zero delay field on coast/surface/descent does not mean recovery |
| Predicted conjunction | LEO / lunar waiting phases | Predicted miss <assumed 1 km | Avoidance manoeuvre; otherwise monitor | Assumed approximate 0.5 m/s |
| Sun or Earth below skyline | Before PDI | Lit alternate passes Earth visibility and, when supplied, fuel margin | Retarget; otherwise hold for next plane window | Plane-change estimate or next-window delay; committed descent continues |

Abort steering targets a bound orbit with perilune ≥15 km and apolune ≥30 km, then cuts thrust and draws an assumed 1,200 s coast. The tested illustrative abort starts 200 s after PDI; the tested divert shifts crossrange 150 m at approach +20 s (assumed scenarios, not universally safe choices). The descent solver may add up to 30 s for a demanding divert, whereas the screening rule assumes time already available. Zero `dvCostMs` on abort/extended-burn decisions means **not computed**, not fuel-free; delay is time to reassessment, not proof of safe waiting.

## 9. Landing constraints

| Check | Requirement | Basis / resolution |
|---|---|---|
| Vertical touchdown speed | Absolute value ≤2 m/s | Assumed; reference run 1.0000 m/s |
| Horizontal touchdown speed | ≤1 m/s | Assumed; reference run 0.0014 m/s |
| Slope | ≤10° | Assumed; LOLA DEM sampled at 20–120 m baseline, default step 120 m; central-difference endpoints are two steps apart |
| Sun above local skyline | Elevation minus skyline >0° at actual landing | JPL Horizons + LOLA [8,9]; picker uses the stricter assumed >0.3° on hourly samples over 48 h |
| Earth above local skyline | Elevation minus skyline >0° at actual landing | Direct-to-Earth geometry, not guaranteed communication quality |

Apollo LM comparison: **10 ft/s vertical, 4 ft/s horizontal, 12° slope — approximate, check TN D-6850** [15]; these figures were not independently verified. DEM-scale slope cannot resolve landing-leg-scale rocks: use LROC NAC or lidar for those hazards. `landingChecks` only includes slope when a sampler is supplied and sky checks when ephemeris is available; an omitted check is not clearance. Recheck the actual shifted landing time and real skyline, rather than trusting the zero-mask example or the picker's requested time.

## 10. Limitations

- Patched conics, no full n-body transfer; the drawn blend between Earth and Moon conics is not a dynamically solved encounter.
- No Earth-equator or launch-site inclination, ascent, launch-window or launch-vehicle performance model.
- Degree-2 gravity only in the separate force model; mission orbit tracks remain point-mass conics. No mascon-driven decay or station-keeping budget; J3 is listed but unused.
- Impulsive TCM/DOI geometry and capture/injection states; displayed finite burn durations do not propagate thrust through the orbit. TCMs spend fuel without correcting the path. DOI plane-change fuel is not yet charged; TLI budget uses mean lunar distance while trajectory apogee uses the dated ephemeris.
- Descent ignores Moon rotation. Flat-sphere descent altitude means height above a smooth constant-radius site sphere, not a flat Cartesian plane; terrain relief is only in the view and landing checks, not collision dynamics.
- Power assumes an ideal battery, free roll and unconstrained antenna pointing; no thermal/aging/charge-rate model. Braking currently uses the `burn`/orbit load rather than the dedicated descent load; TCM attitude changes are not scheduled.
- Vehicle numbers, descent gates, control gains and operational decision thresholds are assumed. Hazard/abort rules are screening decisions, not complete flight software or guarantees of reachable alternatives.
- Environmental estimates are offline and approximate; no live space-weather/conjunction feeds or impact-damage model. Missing terrain/sky checks must not be treated as evidence that a site is safe.

Verification for this documentation snapshot: `node --test 'tests/lander-*.test.mjs'` — 63 passed; `node --test 'tests/*.test.mjs'` — 573 passed, 16 skipped (missing raw-data/backup fixtures), 0 failed. The standalone-page build and browser were not run for this documentation-only task.

## 11. Sources

Source names below are those supplied in the task or code comments; approximate comparisons have not been independently reverified. Assumed parameters are identified in §§5–8 rather than attributed to a publication.

1. CGPM (1901); ISO 80000-3 — conventional standard gravity used for Isp.
2. IAU (2012), Resolution B2 — astronomical unit.
3. Kopp & Lean (2011), *Geophysical Research Letters* 38, L01706 — solar irradiance.
4. IERS Conventions (2010); WGS-84 / EGM96 — Earth GM, equatorial radius and J2, as cited in `constants.js`.
5. IAU (2009) / JPL DE430 — solar GM and shared lunar GM attribution in `constants.js`.
6. IAU mean lunar radius; NASA Moon fact sheet — mean radius and mean Earth–Moon distance, as cited in `constants.js`.
7. Lemoine et al. (2014), *Geophysical Research Letters* 41, 3382; GRAIL GRGM900C. [PDS coefficient file `gggrx_0900c_sha.tab`](https://pds-geosciences.wustl.edu/grail/grail-l-lgrs-5-rdr-v1/grail_1001/shadr/gggrx_0900c_sha.tab).
8. [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) — bundled Sun/Earth ephemeris, `demo/data/ephemeris.json`.
9. [LOLA PDS archive](https://pds-geosciences.wustl.edu/missions/lro/lola.htm) — lunar DEM and derived skyline/slope. LROC NAC is named as a needed high-resolution hazard source, not an input to this descent model.
10. Orloff (2000), *Apollo by the Numbers*, NASA SP-2000-4029 — approximate Apollo parking-orbit, TLI, LOI and DOI comparisons.
11. Bennett (1972), NASA TN D-6846 — approximate Apollo powered-descent Δv comparison, as attributed in `budget.js`.
12. Klumpp (1974), “Apollo lunar descent guidance”, *Automatica* 10, 133–146 — approach guidance-law structure.
13. Folta & Quinn (2006), AIAA 2006-6749 — lunar frozen-orbit discussion supplied in the task.
14. Ely (2005), *Journal of the Astronautical Sciences* 53 — lunar frozen-orbit discussion supplied in the task; PFS-2's ~35-day 1972 lifetime is a separate supplied historical comparison, approximate/unverified here.
15. NASA TN D-6850 — Apollo LM touchdown comparison: **approximate, check TN D-6850**; document/figures not verified here.
16. Wertz & Larson, *Space Mission Analysis and Design* — circular-orbit cylindrical-shadow geometry, as cited in `power.js`.
17. Grün et al. (1985), *Icarus* 62, 244–272 — cumulative micrometeoroid flux fit used by `gruenFlux`.
18. NOAA SWPC, [NOAA Space Weather Scales](https://www.swpc.noaa.gov/noaa-scales-explanation) — solar radiation storm thresholds and average cycle frequencies; NOAA SWPC CME transit description cited approximately in `environment.js`.
19. NASA ORDEM 3.1; launch collision avoidance (COLA) — named debris assessment/screening methods, not run by this app.
20. ISRO press release on Chandrayaan-2 collision avoidance to avoid LRO, manoeuvre **18 Oct 2021**, as cited in `environment.js`.
21. Apollo 17 Lunar Atmospheric Composition Experiment (LACE) — approximate nighttime exosphere density cited in `environment.js`.
22. `vehicle.js` / `mission.js` comparison comments: Apollo LM descent stage, Intuitive Machines Nova-C, ispace HAKUTO-R, RL10-class/RL10B-2 and Chandrayaan-3. Order-of-magnitude, approximate/unverified comparisons; no additional technical publication is claimed.
23. Artemis/Gateway NRHO staging — alternative named in the task; not modelled or assigned numerical performance here.
