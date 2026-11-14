// Physical constants for the lander track (Earth → lunar orbit → south-pole landing). Pure values, no DOM.
// Every number cites its source here and in docs/LANDER.md §6. Units: km, s, kg unless the name says otherwise.
import { MU_MOON as RELAY_MU_MOON, MOON_RATE as RELAY_MOON_RATE, SIDEREAL_MONTH_S as RELAY_SIDEREAL_MONTH_S } from '../relay.js';
import { MOON_RADIUS_KM as GEO_MOON_RADIUS_KM } from '../geometry.js';

// ---------- standard constants ----------
export const G0 = 9.80665;                       // m/s², standard gravity; defines Isp in seconds (CGPM 1901, ISO 80000-3)
export const AU_KM = 149597870.7;                // km, IAU 2012 Resolution B2 (also demo/data/ephemeris.json meta.auKm)
export const SOLAR_CONSTANT_W_M2 = 1361;         // W/m² at 1 AU, total solar irradiance at solar minimum (Kopp & Lean 2011, GRL 38, L01706)

// ---------- Earth ----------
export const MU_EARTH = 398600.4418;             // km³/s², IERS Conventions 2010 / WGS-84 (EGM96)
export const R_EARTH = 6378.137;                 // km, WGS-84 equatorial radius
export const J2_EARTH = 1.08262668e-3;           // WGS-84 (EGM96) unnormalised J2

// ---------- Sun ----------
export const MU_SUN = 1.32712440018e11;          // km³/s², IAU 2009 / JPL DE430

// ---------- Moon ----------
// relay.js keeps 4902.800066 (the task book value, = DE430 GM). GRGM900C's own GM is 4902.79997; the
// difference (2e-8 relative) is far below anything this model resolves, so the whole app shares one value.
export const MU_MOON = RELAY_MU_MOON;            // km³/s²
export const R_MOON = GEO_MOON_RADIUS_KM;        // km, IAU mean radius 1737.4 (geometry.js)
export const MOON_RATE = RELAY_MOON_RATE;        // rad/s, synchronous rotation (relay.js)
export const SIDEREAL_MONTH_S = RELAY_SIDEREAL_MONTH_S;
// GRAIL gravity field GRGM900C (Lemoine et al. 2014, GRL 41, 3382), PDS file
// grail_1001/shadr/gggrx_0900c_sha.tab: reference radius 1738.0 km, fully normalised
// C̄20 = −9.0886616e-5, C̄22 = 3.4673334e-5, C̄30 = −3.1973530e-6. Unnormalised: J2 = −C̄20·√5,
// C22 = C̄22·√(10/24), J3 = −C̄30·√7.
export const R_MOON_GRAV = 1738.0;               // km, GRAIL reference radius
export const C20N_MOON = -9.0886616361343905e-5;
export const C22N_MOON = 3.46733340854267e-5;
export const C30N_MOON = -3.1973529610071702e-6;
export const J2_MOON = -C20N_MOON * Math.sqrt(5);            // ≈ 2.0323e-4
export const C22_MOON = C22N_MOON * Math.sqrt(10 / 24);      // ≈ 2.2382e-5
export const J3_MOON = -C30N_MOON * Math.sqrt(7);            // ≈ 8.459e-6
export const G_MOON_SURFACE = (MU_MOON / (R_MOON * R_MOON)) * 1000;   // m/s², ≈ 1.624
export const EARTH_MOON_MEAN_KM = 384400;        // km, mean Earth–Moon distance (NASA Moon fact sheet)
// Laplace sphere of influence r = a (m/M)^(2/5) with m/M = MU_MOON / MU_EARTH ≈ 0.0123 → ≈ 66,100 km
export const MOON_SOI_KM = EARTH_MOON_MEAN_KM * Math.pow(MU_MOON / MU_EARTH, 0.4);

// ---------- helpers ----------
export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;
export const DAY_S = 86400;
