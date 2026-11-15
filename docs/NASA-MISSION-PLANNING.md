# How NASA plans a lunar landing, and what this tool does about it

*Written 14 November 2026 for the Space Apps Bristol event. It explains, for someone new to the subject, how a
lunar landing mission is organised, how a landing site gets chosen and what happens after touchdown. Every section
ends with **In the tool**: which part of the Lunar Landing Site Navigator covers that step, and what it leaves
out. Facts have a link to the page they came from; where this document or the tool uses a number that is our
own assumption, it says so.*

> **Where the plan stands today.** NASA changed the Artemis plan in 2026. Artemis II flew around the Moon in April
> 2026. Artemis III is now a crewed test in Earth orbit in 2027, and the first crewed landing is Artemis IV, planned
> for early 2028 near the south pole, with Artemis V late in 2028 ([NASA, Artemis III](https://www.nasa.gov/mission/artemis-iii/),
> [Artemis IV](https://www.nasa.gov/mission/artemis-iv/), [fact sheet, Mar 2026](https://www.nasa.gov/wp-content/uploads/2026/03/going-back-to-the-moon-a28cdd.pdf)).
> The candidate landing regions described below were chosen for the earlier Artemis III landing plan. We found no
> NASA page that names a landing region for Artemis IV yet (checked 14 Nov 2026). The tool uses those regions as
> realistic examples, not as a prediction of where NASA will land.

## Contents

1. [The big picture: one chain of decisions](#1-the-big-picture-one-chain-of-decisions)
2. [The project life cycle: how a mission gets approved and built](#2-the-project-life-cycle)
3. [Choosing where to land](#3-choosing-where-to-land)
4. [Getting there: trajectory design](#4-getting-there-trajectory-design)
5. [Landing: accuracy, hazards and the touchdown limits](#5-landing-accuracy-hazards-and-limits)
6. [Robotic landers: CLPS](#6-robotic-landers-clps)
7. [On the surface: light, power, heat, radio and driving](#7-on-the-surface-light-power-heat-radio-and-driving)
8. [What the tool simplifies, in one table](#8-what-the-tool-simplifies-in-one-table)
9. [Sources](#9-sources)

---

## 1. The big picture: one chain of decisions

A landing is not one decision. It is a chain where each link limits the next, and a change anywhere (a launch slip,
a heavier lander) can move the whole chain. NASA's own site-selection teams describe it as an **end-to-end
availability** problem: launch days, transfer geometry, communications, landing performance, lighting and terrain
safety all have to line up on the same day ([NASA JSC, *Artemis IV Landing Site Process Overview*, Sep 2025](https://ntrs.nasa.gov/citations/20250008952)).

```text
 Science goals ──► Candidate regions ──► Date & trajectory ──► Landing site ──► Descent ──► Surface work
 (why go?)         (15 km areas)         (when, which orbit)    (100 m circle)  (touchdown)  (drive, power, talk)

 Tool:  Navigator          Navigator             Lander page       Navigator +     Lander page   Navigator route
        "Sites" + modes    timeline + slip       Δv, window        Lander planner  descent       card + 3D globe
```

The three pages of the tool follow the same order, which is why they share one mission and a three-step bar:
**Plan: 1 Map** (the 3D Moon: site, date, landing spot, rover route) → **2 Finalise** (go / no-go, freeze) →
**Fly: 3 Execute** (the frozen plan flown from launch to surface operations). The [overview page](../demo/overview.html)
shows the same flow with the data and the algorithms behind each step. See the [user guide](GUIDE.md).

---

## 2. The project life cycle

Before any of the physics, a mission is a *project*, and NASA runs projects through fixed phases separated by
decision points. The rules are written in NASA's procedural requirements (NPR 7120.5) and explained in the
[NASA Systems Engineering Handbook (SP-2016-6105 Rev 2)](https://www.nasa.gov/wp-content/uploads/2018/09/nasa_systems_engineering_handbook_0.pdf).

| Phase | Name | Plain-language job |
|---|---|---|
| Pre-Phase A | Concept studies | Collect many mission ideas, check which are feasible, draft top-level requirements, rough cost and schedule |
| A | Concept and technology development | Decide whether the idea is feasible and worth doing; settle the concept, requirements and needed new technology |
| B | Preliminary design | Define the project well enough to set a first baseline; preliminary design of each element |
| C | Final design and fabrication | Finish the detailed design, build hardware, write software |
| D | Assembly, integration, test, launch | Put the pieces together, test hardware, software and people, launch |
| E | Operations and sustainment | Fly the mission and keep support running |
| F | Closeout | Decommission, dispose, archive the data |

Pre-Phase A, A and B are called **Formulation**; C to F are **Implementation**. Phases are separated by **Key
Decision Points (KDPs)**: a go or no-go from the decision authority. A project can pass with "liens" to fix, retry,
or be stopped (SE Handbook, Section 3.0).

The big technical gates inside the phases are reviews, held when the work is ready rather than on a calendar
([NPR 7123.1D](https://nodis3.gsfc.nasa.gov/displayDir.cfm?Internal_ID=N_PR_7123_001D_&page_name=Chapter5)):

| Review | When | The question it answers |
|---|---|---|
| MCR, Mission Concept Review | end of Pre-Phase A | Is there a real need, and is this concept a credible way to meet it? |
| SRR, System Requirements Review | Phase A | Are the requirements complete and consistent with the concept? |
| MDR / SDR, Mission (robotic) or System (human) Definition Review | late Phase A | Does the architecture answer the requirements? |
| PDR, Preliminary Design Review | end of Phase B | Does the preliminary design meet every requirement at acceptable risk, cost and schedule? |
| CDR, Critical Design Review | Phase C | Is the design mature enough to start building? |
| SIR, System Integration Review | end of Phase C | Are parts, facilities and people ready to begin integration? |
| ORR, Operational Readiness Review | Phase D | Do the real system, procedures and people match what will be operated? |
| FRR, Flight Readiness Review | Phase D | Are tests and analyses good enough for a safe launch and flight? |
| PLAR / CERR | Phase E | Ready for routine operations? Ready for a critical event such as orbit insertion or docking? |

(Review purposes: SE Handbook Table 6.7-1.)

Crewed and robotic projects use the same skeleton with different weight. The handbook shows separate review rows
for human spaceflight and robotic missions; for robotic missions the SRR and MDR may be combined, a System Acceptance
Review mostly applies to human flight, and a Post-Flight Assessment Review is human-flight only (SE Handbook, Fig. 3.0-1
and Section 3.11). In NPR 7120.5F any project with a human spaceflight system is Category 1, with the NASA Associate
Administrator as decision authority ([NPR 7120.5F, Chapter 2](https://nodis3.gsfc.nasa.gov/displayDir.cfm?Internal_ID=N_PR_7120_005F_&page_name=Chapter2)).

**In the tool.** The tool lives in **Pre-Phase A and Phase A**: it is a trade-study instrument for the question *"is
this concept and this site credible, and how sensitive is it to a date slip?"* It does not do requirements
management, design or testing. The **Evidence** sheet in the navigator is the nearest thing to a review package:
what data goes in, what check supports the main claim, what is not verified.

---

## 3. Choosing where to land

### 3.1 The funnel: from the whole pole to a 100 m circle

NASA narrows the search in steps. For Artemis it works like this:

1. **The south polar region**, the area within about 6° of latitude of the pole, is surveyed with orbiter data
   ([NASA Lunar Surface Data Book, 2025](https://ntrs.nasa.gov/api/citations/20250002845/downloads/M2M-30044%20Lunar%20Surface%20Data%20Book%20Baseline_Final.pdf)).
2. **Candidate regions**, each about 15 km × 15 km, were published on 19 August 2022: thirteen of them
   ([NASA release 22-089](https://www.nasa.gov/news-release/nasa-identifies-candidate-regions-for-landing-next-americans-on-moon/)).
3. **A shorter list** of nine regions followed on 28 October 2024 ([NASA release 24-136](https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/)).
4. **A landing site**, a circle of about 100 m radius inside a region, is picked once the launch date is known,
   because the date fixes both the transfer path and the lighting at the pole (same release).
5. **Approval at NASA Headquarters** closes the loop: NASA's Artemis IV process briefing states that all Artemis
   site selections are approved at the headquarters level, after a cross-programme analysis team applies weighted
   figures of merit to balance the drivers against mission availability (*Artemis IV Landing Site Process Overview*, linked above).

The thirteen regions of August 2022 were Faustini Rim A, Peak Near Shackleton, Connecting Ridge, Connecting Ridge
Extension, de Gerlache Rim 1, de Gerlache Rim 2, de Gerlache-Kocher Massif, Haworth, Malapert Massif, Leibnitz Beta
Plateau, Nobile Rim 1, Nobile Rim 2 and Amundsen Rim. The nine of October 2024 were Peak near Cabeus B, Haworth,
Malapert Massif, Mons Mouton Plateau, Mons Mouton, Nobile Rim 1, Nobile Rim 2, de Gerlache Rim 2 and Slater Plain.
NASA's own technical write-up of the cut, presented at LPSC in March 2026, says it applied to the earlier Artemis III
landing and not to Artemis IV and later ([NTRS 20250011660](https://ntrs.nasa.gov/citations/20250011660)).

### 3.2 The criteria, and which part of the tool answers each

| What NASA weighs | Why it matters | Source | In the tool |
|---|---|---|---|
| **Sunlight** over the whole surface stay, with low sensitivity to slips | Power and heat. At the pole the Sun stays below about 7.5° above the horizon, and the best pattern shifts by roughly 2 to 3 weeks each year | [LPSC 2026 abstract](https://ntrs.nasa.gov/citations/20250011660), [Data Book](https://ntrs.nasa.gov/api/citations/20250002845/downloads/M2M-30044%20Lunar%20Surface%20Data%20Book%20Baseline_Final.pdf) | **Sunlit** mode, Sky dial, Elevation chart, landing-slip table, 18.6-year average (navigator) |
| **Earth in view**, if the mission uses direct-to-Earth radio | Communications without a relay | LPSC 2026 abstract | **Earth in view** and **Both in view** modes, relay card |
| **Terrain safety**: low slope inside the landing ellipse, few craters and boulders | The lander must stand and the crew must be able to leave it | LPSC 2026 abstract; the polar slope statistics (only about a quarter of the area is under 5°) are in the Data Book | **Max slope** filter, Suitability mode, the lander page's ellipse score (slope, roughness) |
| **Access to permanently shadowed regions** (cold traps that may hold ice) | The science reason to go to the pole | NASA release 22-089 | **PSR** overlay, distance to shadow in the suitability score, PSR share in the lander planner |
| **Launch window and transfer geometry** | The lander's orbit plane must pass over the site; each region works in some months and not others | [NASA JSC, HLS mission design, 2022](https://ntrs.nasa.gov/api/citations/20230002566/downloads/HLS%20NRHO%20to%20Lunar%20Surface%20and%20Back%20Mission%20Design_STRIVES.pptx.pdf) | The lander page's landing time search ("Next lit window") and Δv budget |
| **Robustness and redundancy** | More than one region must stay available so a slip does not cancel the mission | LPSC 2026 abstract | Compare view: planned versus alternative date or site |
| **Science value** (oldest terrain, ice, geological variety) | Why this place and not another | NASA release 22-089; [Artemis III geology team](https://www.nasa.gov/general/nasa-selects-geology-team-for-the-first-crewed-artemis-lunar-landing/) | Not modelled |

**In the tool.** The navigator's "Sites" list is the funnel's middle step: eight of the nine 2024 regions are in it
(Peak near Cabeus B, Haworth, Malapert Massif, Mons Mouton Plateau, Mons Mouton, Nobile Rim 1, Nobile Rim 2,
de Gerlache Rim 2; Slater Plain is not), marked "approx." where the coordinates are ours, next to real landing
sites (Apollo 11 and 17, Chandrayaan-3, Chang'e-4, IM-1, IM-2, Blue Ghost M1) and the Shackleton ridge. The
**Suitability** mode is the "weighted figures of merit" idea in miniature: sun 40, Earth 30, slope 20, shadow
nearness 10 (our weights, adjustable in Layers, listed in [VARIABLES.md](VARIABLES.md) §6). It does not know about
launch vehicles, and it cannot judge science value.

---

## 4. Getting there: trajectory design

### 4.1 Earth to the Moon

A spacecraft leaves Earth orbit with one long engine burn, **trans-lunar injection (TLI)**, that puts it on a path
to the Moon. Artemis II used a *free-return* path: after TLI the Moon's gravity swings the spacecraft back to Earth
without another big burn, only small trajectory-correction burns ([Artemis II press kit](https://www.nasa.gov/wp-content/uploads/2026/01/artemis-ii-press-kit.pdf)).
A landing mission also needs a lander, and an orbit around the Moon where the crew vehicle can wait.

### 4.2 The Artemis orbit, and why it changed

The Artemis baseline was the **near-rectilinear halo orbit (NRHO)**: a long, thin, stretched orbit around the Moon
with a period of about 6.5 days, passing roughly 1,500 to 1,800 km above the south pole at its closest and about
68,000 to 70,000 km at its farthest ([Davis et al., NASA JSC, 2020](https://ntrs.nasa.gov/api/citations/20200000733/downloads/20200000733.pdf)). NASA gave
these reasons: it is nearly stable (little fuel to stay there), it keeps Earth in view for near-continuous radio,
entering and leaving costs about half the velocity change of a low lunar orbit, and it gives good access to the
south pole ([NASA JSC, *NRHO: the Artemis orbit*, 2023](https://www.nasa.gov/wp-content/uploads/2023/10/nrho-artemis-orbit.pdf)).
A lander would leave the NRHO, brake into a 100 km circular orbit, wait a few revolutions, drop its low point to
about 15 km, then start the powered descent near that low point ([NASA JSC, 2022](https://ntrs.nasa.gov/api/citations/20230002566/downloads/HLS%20NRHO%20to%20Lunar%20Surface%20and%20Back%20Mission%20Design_STRIVES.pptx.pdf)).

That design is now **superseded**. On 24 March 2026 NASA said it would halt Gateway in its current form
([NASA release](https://www.nasa.gov/news-release/nasa-unveils-initiatives-to-achieve-americas-national-space-policy/)), and on 23 October 2026 it said neither lander will meet Orion in the NRHO any more. Instead the Starship lander
will dock with Orion in Earth orbit and perform the trans-lunar burn itself, while the Blue Moon lander meets Orion
in an elliptical polar lunar orbit ([NASA, 23 Oct 2026](https://www.nasa.gov/missions/artemis/nasa-partners-accelerate-lander-development-for-2028-moon-missions/)). NASA's reasons include a faster return from the surface to Orion and lower
lander propellant.

### 4.3 Choosing the landing date

Two things fix the date. The lander's orbit plane around the Moon must pass over the site, and a plane change costs
fuel, so some sites cost a lot more velocity change than others; lining the low point of the descent orbit up with
the site takes extra "phasing" revolutions (NASA JSC, 2022, above). And the Sun must be well placed at the site for
the whole stay. Apollo is the old example: it wanted the Sun low behind the lander, which gave one launch window
per month for a site ([NASA, *Lunar Landing Sites Selected*](https://www.nasa.gov/history/50-years-ago-lunar-landing-sites-selected/)).
At the pole the window logic is stricter, because the Sun never climbs high and shadows are long.
NASA's 2024 lander overview counted about 55 possible landing opportunities a year (one per orbit of the NRHO) and
about 28 usable once Earth-Moon mechanics and launch-vehicle limits are applied, before lighting and radio filters
([NASA Langley, Artemis HLS overview](https://ntrs.nasa.gov/api/citations/20250009323/downloads/ArtemisOverview2025IntSPAPPSChallenge.pdf));
that count belonged to the Gateway plan, so treat it as an example of the size of the problem.

### 4.4 The numbers, to give a feel for the size

* NASA's workshop slides put the energy cost of reaching the lunar surface from the Earth-Moon transfer at roughly
  2,750 m/s, about 900 m/s for low lunar orbit and about 450 m/s for the NRHO (order of magnitude only; [NASA JSC, 2023](https://www.nasa.gov/wp-content/uploads/2023/10/nrho-artemis-orbit.pdf)).
* A NASA study budget for a lander going between the NRHO and a low lunar orbit and back was about 740 m/s each way
  ([Langley/AMA, AIAA 2020](https://ntrs.nasa.gov/api/citations/20200002920/downloads/20200002920.pdf)).
* Apollo 11's powered descent lasted 12 minutes 34 seconds ([Apollo 11 Lunar Surface Journal](https://www.nasa.gov/wp-content/uploads/static/history/alsj/a11/a11.landing.html)).

**In the tool.** The **lander page** is a compact version of this chain for a *generic robotic lander*: parking
orbit, TLI, coast, a 100 km polar lunar orbit, descent orbit, powered descent, with a Δv budget compared to
published Apollo ranges ([LANDER.md](LANDER.md)). What it simplifies: patched conics instead of a full n-body
transfer, no launch-site or launch-vehicle model, a **polar lunar orbit instead of the NRHO** (the NRHO is documented
there as not modelled, and after NASA's October 2026 change it is no longer the landing baseline anyway), an
impulsive treatment of the small burns, and an assumed vehicle (800 kg dry, 1,400 kg propellant, 4.5 kN, 320 s). It
finds the landing time by asking when the site's lighting and Earth view work and when the orbit plane aligns.

---

## 5. Landing: accuracy, hazards and limits

### 5.1 How precisely can a lander land?

* **Apollo 11** touched down about 6.6 km (4 miles) beyond its target; part of that came from the crew flying past
  a boulder field and part from speed errors before the descent began ([Apollo 11 mission summary, SP-4029](https://www.nasa.gov/wp-content/uploads/static/history/SP-4029/Apollo_11a_Summary.htm),
  [Lunar Surface Journal](https://www.nasa.gov/wp-content/uploads/static/history/alsj/a11/a11.landing.html)). On Apollo 11, 12, 14, 16 and 17 the commander took manual control because of hazardous
  ground at the computer's aim point ([NASA OIG IG-26-004](https://oig.nasa.gov/wp-content/uploads/2026/03/final-report-ig-26-004-nasas-management-of-the-human-landing-system-contracts.pdf)).
* **Today's target.** NASA's Human Landing System must land within **50 m** of the target from Artemis IV on,
  under any lighting ([NASA JSC, 2025](https://ntrs.nasa.gov/api/citations/20250003778/downloads/JSC_CIF_ATRN_Overview.pdf)). The
  uncrewed demonstration landings must come within **100 m** of a target ([NASA HLS paper, IAC 2026](https://ntrs.nasa.gov/api/citations/20260008717/downloads/HLS%20IAC%202026%20FINAL.pdf)). These are programme
  targets; the same NASA slide lists IM-2 as the best polar result so far, about 250 m (a NASA page puts IM-2's touchdown
  at about 400 m from its intended spot, so the two sources differ).
* **ISRO's Chandrayaan-3** was aimed at a 4 km × 2.4 km area at 69.37°S ([ISRO](https://www.isro.gov.in/Chandrayaan3_Details.html)); NASA lists its touchdown at 69.3741°S, 32.32°E, about 0.35 km from the centre of that area by our own arithmetic ([NASA Data Book](https://ntrs.nasa.gov/api/citations/20250002845/downloads/M2M-30044%20Lunar%20Surface%20Data%20Book%20Baseline_Final.pdf)).

### 5.2 How landers see hazards

The Apollo crews looked out of the window. Modern landers use sensors: NASA's SPLICE suite combines a Navigation
Doppler Lidar (speed and height, from about 10 km up), a hazard-detection lidar that builds a 3D map from about
500 m up, and terrain-relative navigation that matches camera images to a stored orbital map ([NASA SPLICE](https://www.nasa.gov/safe-and-precise-landing-integrated-capabilities-evolution-splice/)). Camera matching is impractical
in permanent shadow, which is why NASA also develops active lidar mapping (JSC, 2025, above).

### 5.3 What a lander can stand on

* Apollo's lunar module was analysed for slopes up to 12°; with its statistical model of the worst Apollo site, the
  chance of an unstable landing on slopes of 12° or less was 2 in 1,000 ([Rogers, NASA 1973](https://www.nasa.gov/wp-content/uploads/static/history/alsj/LM_Landing%20Gear1973010151.pdf)).
* For the Artemis landers NASA set a post-landing tilt limit of no more than 8°, while polar slopes reach about 20° and
  boulders over 20 m across exist (NASA OIG, 2026).
* The south polar region is rough: in NASA's slope statistics about a quarter of the area is under 5°, a third between
  5° and 10°, and about a fifth steeper than 15° (Data Book, from 5 m baselines).
* The Apollo site rules were stricter: general slope under 2° over a 3 × 5 mile area (*Lunar Landing Sites Selected*, above).

**In the tool.** The lander page scores a pick with an **assumed 3σ landing ellipse of 150 m down-range by 100 m
cross-range**, an **assumed 10° slope limit** and an assumed touchdown speed (2 m/s vertical, 1 m/s horizontal), then
shows pass / near / fail for each. Those are *our assumptions for a generic lander*, set in the same order of size as
the NASA numbers above, not NASA requirements. It uses real LOLA terrain down to 5 m near the listed sites
and says plainly that **rocks and boulders are not modelled** (a 5–20 m DEM cannot see a 1 m rock). It also
draws illustrative dust and a 150 m divert ring; the divert reach is an assumption.

---

## 6. Robotic landers: CLPS

Before crews return, NASA is sending robots. **Commercial Lunar Payload Services (CLPS)** is NASA buying delivery
of science and technology payloads to the Moon *as a service* from US companies: the company builds the lander,
buys its own launch and carries NASA's instruments; NASA picks the payloads and the landing area but not the
lander's design. Task orders are firm-fixed-price ([NASA CLPS page](https://www.nasa.gov/commercial-lunar-payload-services/),
[NASA OIG IG-24-013](https://oig.nasa.gov/wp-content/uploads/2024/06/final-report-ig-24-013-nasas-commercial-lunar-payload-services-initiative.pdf)).

| Mission | Date | Where | What happened | Source |
|---|---|---|---|---|
| Peregrine Mission One (Astrobotic) | launched 8 Jan 2024 | planned for Sinus Viscositatis | A propulsion problem kept it from landing; controlled re-entry on 18 Jan 2024 | [NASA](https://www.nasa.gov/news-release/nasa-science-astrobotic-peregrine-mission-one-concludes/) |
| IM-1 *Odysseus* (Intuitive Machines) | landed 22 Feb 2024 | 80.13°S, 1.44°E, inside a degraded 1 km crater near Malapert A | First CLPS soft landing; it tipped onto its side | [NASA LRO](https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/), [OIG](https://oig.nasa.gov/wp-content/uploads/2024/06/final-report-ig-24-013-nasas-commercial-lunar-payload-services-initiative.pdf) |
| Blue Ghost Mission 1 (Firefly) | landed 2 Mar 2025 | Mare Crisium, near Mons Latreille | Worked about one lunar day plus a few hours of night; all 10 NASA payloads returned data | [NASA](https://www.nasa.gov/news-release/touchdown-carrying-nasa-science-fireflys-blue-ghost-lands-on-moon/), [NASA](https://www.nasa.gov/news-release/nasa-science-continues-after-fireflys-first-moon-mission-concludes/) |
| IM-2 *Athena* (Intuitive Machines) | landed 6 Mar 2025 | about 84.79°S, 29.20°E on Mons Mouton, the closest to the pole of any lander so far; about 400 m from the aim point | Ended up on its side in a crater about 20 m across, could not recharge, and worked roughly 10 hours instead of the planned 10 days | [NASA](https://www.nasa.gov/missions/artemis/nasas-lunar-drill-technology-passes-tests-on-the-moon/), [LROC](https://lroc.im-ldi.com/images/1408) |

Outside CLPS, **India's Chandrayaan-3** landed on 23 August 2023 at 69.37°S, 32.32°E, in the highlands near the
south pole but far from the pole itself ([NASA LRO](https://www.nasa.gov/image-article/nasas-lro-observes-chandrayaan-3-landing-site/), [ISRO](https://www.isro.gov.in/Chandrayaan3_Details.html)).

As of 14 November 2026 NASA's pages show no CLPS landing since March 2025. NASA's Moon Base page lists the next
ones in future tense: Blue Origin's Blue Moon Mark 1 to the Shackleton Connecting Ridge, Griffin-1, IM-3 and Blue
Ghost 2 ([NASA Moon Base phases](https://www.nasa.gov/moonbase-phases/)). On 7 November 2026 NASA raised the CLPS
ceiling and announced a second ten-year CLPS contract ([NASA release](https://www.nasa.gov/news-release/nasa-awards-moon-base-transportation-technology-science-projects/)).

**Why it matters here.** Two of the four missions that tried landed on their side, both close to the pole or on
slopes. That is the practical reason slope, roughness and lighting dominate the site checks.

**In the tool.** IM-1, IM-2, Blue Ghost M1 and Chandrayaan-3 are in the site list so you can see their terrain and
sky. The ephemeris in the tool starts on 1 November 2026, so it **cannot replay the days those landers actually
landed**; it shows what the same place would look like for a landing in 2027 or 2028.

---

## 7. On the surface: light, power, heat, radio and driving

### 7.1 Light: a Sun that never gets high

The Moon's spin axis is tilted only about 1.5° from the plane of its orbit around the Sun, so at the poles the Sun
circles the horizon instead of rising and setting ([NASA, Why Artemis will focus on the south polar region](https://www.nasa.gov/wp-content/uploads/2023/10/acr22-wp-why-lunar-south-polar-region.pdf);
[NASA SVS](https://svs.gsfc.nasa.gov/5038)). Within 6° of the pole the Sun stays below about 7.5° (the Data Book gives
7.5° for the whole zone; 6° plus the 1.54° tilt is the arithmetic). Low Sun means long shadows: with the Sun 2° up,
a shadow is about 28 times the height of the object that casts it ([NASA ESC, 2023](https://ntrs.nasa.gov/api/citations/20230006101/downloads/PowerPoint%20Presentation.pdf)),
and mountains up to about 120 km away can shade a site ([NASA OCHMO-TB-001](https://www.nasa.gov/wp-content/uploads/2023/12/ochmo-tb-001-artemis-lighting-considerations.pdf)).

* The best spot on the Shackleton rim is sunlit continuously for about 240 days a year, with its longest dark spell
  about 1.5 days ([Mazarico et al., Icarus 2011](https://ntrs.nasa.gov/citations/20120010094)). NASA also states that
  no known location in the south polar region is *continuously* sunlit ([NASA, Lunar Site Selection, 2023](https://ntrs.nasa.gov/api/citations/20230016267/downloads/Lunar%20Site%20Selection.pdf)).
* Lighting follows the Moon's own seasons, which drift through the Earth calendar: the good months move 2 to 3 weeks
  earlier each year ([NASA, Artemis HLS overview](https://ntrs.nasa.gov/api/citations/20250009323/downloads/ArtemisOverview2025IntSPAPPSChallenge.pdf),
  [LPSC 2026 abstract](https://ntrs.nasa.gov/citations/20250011660)). NASA's illumination maps are averages over a
  full 18.6-year cycle of the Moon's orbit, computed hour by hour ([PGDA lunar polar illumination](https://pgda.gsfc.nasa.gov/products/69)).
  A **lunar day**, sunrise to sunrise, averages 29.53 Earth days ([NASA SVS](https://svs.gsfc.nasa.gov/12739/)).

**In the tool.** Everything on the *Sun & Earth* side of the navigator is this: the real Sun direction from JPL
Horizons above the real skyline from LOLA, hour by hour for the stay; the 18.6-year average from NASA's map; the
*Real light* terrain style that casts shadows with the Sun at the playhead. It does **not** model Earthshine or
sunlight scattered into shadow, and the skyline grids are 1 to 2 km for the map (480 m at a chosen site), so
small nearby relief can be missed.

### 7.2 Cold and permanently shadowed regions

Some crater floors near the pole have not seen sunlight for billions of years. NASA's engineering design table for
the lunar environment runs from 18 K (−255 °C) in permanently shadowed regions to 394 K (121 °C) at equatorial noon
([NASA Lunar Surface Data Book](https://ntrs.nasa.gov/api/citations/20250002845/downloads/M2M-30044%20Lunar%20Surface%20Data%20Book%20Baseline_Final.pdf)),
and the Diviner instrument has measured about −248 °C at crater bottoms ([NASA](https://science.nasa.gov/solar-system/moon/10-cool-things-nasas-lunar-reconnaissance-orbiter-is-teaching-us-about-the-moon/)).
Mazarico and colleagues mapped these regions from laser-altimeter terrain: about 16,000 km² in the south, each still
receiving some scattered light ([NTRS](https://ntrs.nasa.gov/citations/20120010094)). Evidence for water ice comes from
the LCROSS impact into Cabeus in 2009 ([NASA](https://science.nasa.gov/mission/lcross/)), from the Moon Mineralogy
Mapper on Chandrayaan-1 ([JPL](https://jpl.nasa.gov/news/news.php?feature=7218)) and from LRO neutron data ([NASA](https://science.nasa.gov/solar-system/moon/nasas-lro-lunar-ice-deposits-are-widespread/)).
NASA cautions that not every shadowed region has ice, and some partly sunlit places seem to ([NASA white paper](https://www.nasa.gov/wp-content/uploads/2023/10/acr22-wp-why-lunar-south-polar-region.pdf)).

**In the tool.** The PSR layer is that official map (Mazarico et al. 2011, 2016 update, 120 m); the route card
counts the kilometres of a route inside one. The tool has no temperature or ice data.

### 7.3 Power and heat

Solar ridges give long sunlit spells, but even the best spots go dark for hours to days. NASA's Data Book tells
planners to use **150 hours of continuous darkness** as the design case for a mobile asset when site data is missing,
and notes that surviving 85 hours is enough for traverses under 10 km at any time of the month, while longer
ones fit in lunar summer ([Data Book, App. E](https://ntrs.nasa.gov/api/citations/20250002845/downloads/M2M-30044%20Lunar%20Surface%20Data%20Book%20Baseline_Final.pdf)).
Batteries are heavy; NASA is working on radioisotope heaters and generators and on fission power ([NASA Moon Base systems](https://www.nasa.gov/moonbase-systems/),
[NASA fission directive, Aug 2025](https://www.nasa.gov/wp-content/uploads/2025/08/nasa-fsp-directive-aug42.pdf)).
VIPER (below) was sized for about 9 hours of shadowed work and parked in high-ground "safe havens" where darkness
lasts about four days ([NASA VIPER](https://science.nasa.gov/mission/viper/in-depth/), [NASA Ames, 2025](https://ntrs.nasa.gov/api/citations/20250004148/downloads/viper-2025-04-24.pdf)).

**In the tool.** The drive simulation runs the battery forward in time: panel power only where the Sun clears the
local skyline, load plus drive plus climbing power, parking to recharge below a 20 % reserve, and a "find good
departure times" search. The **longest dark spell** filter and the lander planner's battery check are the "150 hours"
idea in small. All power figures (450 W panel, 4,000 Wh, 120 W load, 450 kg) are **our assumptions**, not a real
rover's data (see [VARIABLES.md](VARIABLES.md) §3). There is **no thermal model**: nothing tells you whether the rover
would survive the cold.

### 7.4 Radio: Earth is low and comes and goes

From the south pole Earth is above the horizon only about half of every sidereal month and is then always close to
the horizon ([NASA, Lunar Communications and Navigation Architecture](https://www.nasa.gov/wp-content/uploads/2024/01/lunar-communications-and-navigation-architecture.pdf)).
That is why the early Artemis plans assumed direct-to-Earth radio and why NASA is building relays: the LunaNet
standards and the Lunar Communications Relay and Navigation Systems (LCRNS), with Intuitive Machines selected as
the first provider ([NASA LunaNet](https://www.nasa.gov/communicating-with-missions/lunanet/),
[NASA LCRNS](https://www.nasa.gov/goddard/esc/lcrns/)). JPL has studied a lunar *surface station* on the Connecting
Ridge to give early navigation and relay service to rovers (Jun et al., IEEE Aerospace 2025, the paper the tool's
comms model follows; [JPL poster](https://www.jpl.nasa.gov/site/research/media/posters/2024/R24215p.pdf)). A
caution from NASA's own data page: the "Earth visible" maps count any sliver of the Earth's disc, so they can be
slightly optimistic for a deep-space-network link ([PGDA](https://pgda.gsfc.nasa.gov/products/69)).

**In the tool.** *Earth in view* is the direct link above the skyline; the relay card uses *example* relay orbits;
the route card's *surface station* link uses the JPL site, mast heights and bands with free-space loss plus knife-edge
diffraction over the terrain (ITU-R P.526). The transmitter power and the −110 dBm threshold are assumptions, and
no data rate, antenna pointing or fading is modelled.

### 7.5 Driving: how a traverse is planned

NASA's Data Book describes the order of work for a traverse ([Data Book, §7](https://ntrs.nasa.gov/api/citations/20250002845/downloads/M2M-30044%20Lunar%20Surface%20Data%20Book%20Baseline_Final.pdf)):

1. start from the best terrain model (1 to 5 m per pixel) and turn it into slope maps;
2. mark the permanently shadowed regions and keep ordinary traverses out of them;
3. pick start and end points and generate paths that stay under the vehicle's up and down slope limits;
4. then add sunlight over time along each candidate path, Earth line of sight, temperature and soil checks, to choose
   departure times and see how far the vehicle can go before it must recharge.

Published limits give a feel for the numbers: VIPER was designed for 15° slopes and 20 cm steps, with a 20 km drive
goal, and was meant to be driven from Earth almost live because the radio delay to the Moon is seconds, not the
minutes of Mars ([NASA Ames, 2025](https://ntrs.nasa.gov/api/citations/20250004148/downloads/viper-2025-04-24.pdf)).
VIPER was cancelled on 17 July 2024, reinstated on 19 September 2025 on a Blue Origin lander, and NASA says it was
fully built and in final testing on 20 October 2026 ([NASA](https://www.nasa.gov/missions/moon-base/nasa-provides-progress-update-on-moon-base-rovers/)).
The crewed Lunar Terrain Vehicle must handle slopes up to 20° and survive 150 hours in shadow ([NASA Moon Base systems](https://www.nasa.gov/moonbase-systems/)).
Apollo's rover never went farther than 7.6 km from its lander, the distance a suited crew could walk back
([NASA OCHMO-TB-023](https://www.nasa.gov/wp-content/uploads/2023/12/ochmo-tb-023-extraterrestrial-surface-transport-vehicles-rovers.pdf)).
For self-driving, Mars rovers are the reference: Perseverance's AutoNav builds a 3D map, finds hazards and picks its
own path between stops that humans set ([JPL](https://www.jpl.nasa.gov/news/nasas-self-driving-perseverance-mars-rover-takes-the-wheel/)).

**In the tool.** The route card follows the same order: terrain slopes, direction-dependent climb, descent and
across limits (assumed 15°, 20°, 12°), PSR kilometres, then sunlight, battery and radio along the path, and a search
for departure times. The *self-driving planner* (B-RRT\*) is a research-style planner of the kind AutoNav
represents, not a copy of any NASA software. It checks slopes on a 240 m grid, so **rover-scale rocks and slopes
are not seen**, and the card says it cannot tell whether a real vehicle could drive the route.

### 7.6 The data behind it all

Almost everything above rests on one NASA instrument, the **Lunar Orbiter Laser Altimeter (LOLA)** on the Lunar
Reconnaissance Orbiter (LRO), which has been mapping since 2009. LOLA fires a laser split into five beams 28 times a
second and records height, roughness and reflectance; NASA's illumination, slope and landing studies are built on it
([Data Book, pp. 12 to 16](https://ntrs.nasa.gov/api/citations/20250002845/downloads/M2M-30044%20Lunar%20Surface%20Data%20Book%20Baseline_Final.pdf),
[NASA LRO](https://science.nasa.gov/mission/lro/)). The 5 m south-pole elevation models are mostly interpolated
between laser tracks (about 90 % of pixels), with a median slope error of 1.5° to 2.5° ([PGDA](https://pgda.gsfc.nasa.gov/products/78)).
This is exactly the data in the tool's README resource table.

**In the tool.** This is why the tool shows resolution next to its numbers ("Terrain 480 m", "LOLA 5 m") and why its
slopes are "mean slope over a 240 m grid; real lander-scale slopes are steeper".

---

## 8. What the tool simplifies, in one table

| Real mission step | What the tool does | What it leaves out |
|---|---|---|
| Life cycle, reviews, requirements | Pre-Phase A / A trade study: compare sites and dates | Requirements, design, testing, risk management, cost |
| Region and site selection | Sites list with Artemis candidate regions ("approx." where ours), suitability score with adjustable weights | NASA's weighting, science value, programmatic constraints, any non-polar site |
| Illumination | Real Sun direction and LOLA skyline, hour by hour; 18.6-year NASA average; shadows in *Real light* | Earthshine, scattered light, small relief below the 1–2 km skyline grids, rocks |
| Earth visibility | Earth above the skyline; example relay orbits; JPL-style surface station link | Link budget, data rate, DSN scheduling, fading |
| Trajectory | Patched-conic Earth–Moon transfer, 100 km polar lunar orbit, descent orbit, powered descent, Δv vs Apollo ranges | NRHO and Gateway, launch vehicle and site, n-body gravity, mascon decay, station-keeping |
| Landing accuracy | Assumed 3σ ellipse 150 × 100 m, slope and roughness scored over it | Real guidance error, terrain-relative navigation, rocks, plume–soil interaction (dust and contact ring are illustrative only) |
| Contingencies | Eight decisions with Δv and delay, four drawn as alternative trajectories | Flight rules, operations teams, solar particle events for the rover |
| Rover traverse | Slope-limited routes, one-way and trap ground, battery and comms along the route, havens, B-RRT\* planner | Soil mechanics, thermal survival, rocks and steps, wheel slip, operations team in the loop |
| Surface power and heat | Battery and panel simulation from Sun above the skyline | Thermal model, battery ageing, RTG or fission options |

Every vehicle, rover and radio figure in the tool is an assumption you can change, and every card says so. The full
list with sources is in [VARIABLES.md](VARIABLES.md) and [LANDER.md](LANDER.md).

---

## 9. Sources

Pages were read on 14 November 2026. Where a link is a NASA Technical Reports Server (NTRS) entry, the title is
given. This document paraphrases; it does not reproduce passages.

**Project life cycle and reviews**
* NASA Systems Engineering Handbook, SP-2016-6105 Rev 2 ([PDF](https://www.nasa.gov/wp-content/uploads/2018/09/nasa_systems_engineering_handbook_0.pdf); [online](https://www.nasa.gov/reference/systems-engineering-handbook/))
* NPR 7120.5F, Chapter 2 ([NODIS](https://nodis3.gsfc.nasa.gov/displayDir.cfm?Internal_ID=N_PR_7120_005F_&page_name=Chapter2)); NPR 7123.1D, Chapter 5 ([NODIS](https://nodis3.gsfc.nasa.gov/displayDir.cfm?Internal_ID=N_PR_7123_001D_&page_name=Chapter5))

**Artemis, regions and sites**
* [NASA identifies candidate regions for landing next Americans on Moon](https://www.nasa.gov/news-release/nasa-identifies-candidate-regions-for-landing-next-americans-on-moon/), 19 Aug 2022
* [NASA provides update on Artemis III Moon landing regions](https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/), 28 Oct 2024
* [Artemis III site selection update: downselection from thirteen to nine candidate regions](https://ntrs.nasa.gov/citations/20250011660), LPSC 2026 abstract
* [Artemis IV landing site process overview](https://ntrs.nasa.gov/citations/20250008952), NASA JSC, Sep 2025
* [NASA selects geology team for the first crewed Artemis lunar landing](https://www.nasa.gov/general/nasa-selects-geology-team-for-the-first-crewed-artemis-lunar-landing/), 22 Aug 2023
* Mission pages: [Artemis III](https://www.nasa.gov/mission/artemis-iii/), [Artemis IV](https://www.nasa.gov/mission/artemis-iv/), [NASA adds mission to Artemis (27 Feb 2026)](https://www.nasa.gov/news-release/nasa-adds-mission-to-artemis-lunar-program-updates-architecture/), [fact sheet](https://www.nasa.gov/wp-content/uploads/2026/03/going-back-to-the-moon-a28cdd.pdf), [NASA initiatives (24 Mar 2026)](https://www.nasa.gov/news-release/nasa-unveils-initiatives-to-achieve-americas-national-space-policy/), [Moon Base](https://www.nasa.gov/moonbase/)
* [NASA, partners accelerate lander development for 2028 Moon missions](https://www.nasa.gov/missions/artemis/nasa-partners-accelerate-lander-development-for-2028-moon-missions/), 23 Oct 2026

**Trajectories and landing**
* [Artemis II press kit](https://www.nasa.gov/wp-content/uploads/2026/01/artemis-ii-press-kit.pdf)
* Davis et al., [Phase control and eclipse avoidance in near rectilinear halo orbits](https://ntrs.nasa.gov/api/citations/20200000733/downloads/20200000733.pdf), 2020
* [NRHO: the Artemis orbit](https://www.nasa.gov/wp-content/uploads/2023/10/nrho-artemis-orbit.pdf), NASA JSC, 2023
* [HLS NRHO to lunar surface and back mission design](https://ntrs.nasa.gov/api/citations/20230002566/downloads/HLS%20NRHO%20to%20Lunar%20Surface%20and%20Back%20Mission%20Design_STRIVES.pptx.pdf), NASA JSC, 2022
* [Langley/AMA lander concept study](https://ntrs.nasa.gov/api/citations/20200002920/downloads/20200002920.pdf), AIAA 2020
* [NASA's Human Landing System: demonstrating the capability to land Artemis astronauts on the Moon by 2028](https://ntrs.nasa.gov/api/citations/20260008717/downloads/HLS%20IAC%202026%20FINAL.pdf), IAC 2026
* [Precision landing and hazard avoidance: active TRN](https://ntrs.nasa.gov/api/citations/20250003778/downloads/JSC_CIF_ATRN_Overview.pdf), NASA JSC, 2025
* [NASA SPLICE](https://www.nasa.gov/safe-and-precise-landing-integrated-capabilities-evolution-splice/)
* [NASA OIG IG-26-004, management of the HLS contracts](https://oig.nasa.gov/wp-content/uploads/2026/03/final-report-ig-26-004-nasas-management-of-the-human-landing-system-contracts.pdf), Mar 2026
* [Lunar Landing Sites Selected (Apollo)](https://www.nasa.gov/history/50-years-ago-lunar-landing-sites-selected/); [Apollo 11 mission summary SP-4029](https://www.nasa.gov/wp-content/uploads/static/history/SP-4029/Apollo_11a_Summary.htm); [Apollo 11 Lunar Surface Journal, the first lunar landing](https://www.nasa.gov/wp-content/uploads/static/history/alsj/a11/a11.landing.html); Rogers, [Apollo lunar module landing gear](https://www.nasa.gov/wp-content/uploads/static/history/alsj/LM_Landing%20Gear1973010151.pdf), 1973
* [ISRO, Chandrayaan-3 details](https://www.isro.gov.in/Chandrayaan3_Details.html); [NASA LRO observes the Chandrayaan-3 landing site](https://www.nasa.gov/image-article/nasas-lro-observes-chandrayaan-3-landing-site/)

**Robotic landers and surface operations**
* [NASA CLPS](https://www.nasa.gov/commercial-lunar-payload-services/); [NASA OIG IG-24-013](https://oig.nasa.gov/wp-content/uploads/2024/06/final-report-ig-24-013-nasas-commercial-lunar-payload-services-initiative.pdf)
* [Peregrine Mission One concludes](https://www.nasa.gov/news-release/nasa-science-astrobotic-peregrine-mission-one-concludes/); [LRO images Odysseus](https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/); [Blue Ghost lands](https://www.nasa.gov/news-release/touchdown-carrying-nasa-science-fireflys-blue-ghost-lands-on-moon/); [Blue Ghost mission concludes](https://www.nasa.gov/news-release/nasa-science-continues-after-fireflys-first-moon-mission-concludes/); [lunar drill technology passes tests (IM-2)](https://www.nasa.gov/missions/artemis/nasas-lunar-drill-technology-passes-tests-on-the-moon/); [LROC, IM-2 Athena seen obliquely](https://lroc.im-ldi.com/images/1408); [Moon Base phases](https://www.nasa.gov/moonbase-phases/); [Moon Base awards, 7 Nov 2026](https://www.nasa.gov/news-release/nasa-awards-moon-base-transportation-technology-science-projects/)
* [NASA Moon Base systems](https://www.nasa.gov/moonbase-systems/); [Moon Base rovers update, 20 Oct 2026](https://www.nasa.gov/missions/moon-base/nasa-provides-progress-update-on-moon-base-rovers/); [VIPER in depth](https://science.nasa.gov/mission/viper/in-depth/); Fong, [VIPER rover design and mission operations](https://ntrs.nasa.gov/api/citations/20250004148/downloads/viper-2025-04-24.pdf), NASA Ames, 2025
* [NASA Lunar Surface Data Book, NASA/TP-20250002845](https://ntrs.nasa.gov/api/citations/20250002845/downloads/M2M-30044%20Lunar%20Surface%20Data%20Book%20Baseline_Final.pdf), 2025
* [Why Artemis will focus on the lunar south polar region](https://www.nasa.gov/wp-content/uploads/2023/10/acr22-wp-why-lunar-south-polar-region.pdf); [Lunar site selection](https://ntrs.nasa.gov/api/citations/20230016267/downloads/Lunar%20Site%20Selection.pdf); [Artemis lighting considerations, OCHMO-TB-001](https://www.nasa.gov/wp-content/uploads/2023/12/ochmo-tb-001-artemis-lighting-considerations.pdf); [Extraterrestrial surface transport vehicles, OCHMO-TB-023](https://www.nasa.gov/wp-content/uploads/2023/12/ochmo-tb-023-extraterrestrial-surface-transport-vehicles-rovers.pdf); [Risks to EVA from lighting at the lunar south pole, NESC](https://ntrs.nasa.gov/api/citations/20230006101/downloads/PowerPoint%20Presentation.pdf); [Artemis HLS overview, NASA Langley](https://ntrs.nasa.gov/api/citations/20250009323/downloads/ArtemisOverview2025IntSPAPPSChallenge.pdf)
* Mazarico et al., [Illumination conditions of the lunar polar regions using LOLA topography](https://ntrs.nasa.gov/citations/20120010094), Icarus 211, 2011; [PGDA lunar polar illumination](https://pgda.gsfc.nasa.gov/products/69); [PGDA south-pole 5 m LOLA DEM](https://pgda.gsfc.nasa.gov/products/78); [NASA LRO](https://science.nasa.gov/mission/lro/); [NASA SVS, the Sun's path at different lunar latitudes](https://svs.gsfc.nasa.gov/5038); [NASA SVS, lunar day length](https://svs.gsfc.nasa.gov/12739/)
* [10 cool things LRO is teaching us](https://science.nasa.gov/solar-system/moon/10-cool-things-nasas-lunar-reconnaissance-orbiter-is-teaching-us-about-the-moon/); [LCROSS](https://science.nasa.gov/mission/lcross/); [JPL, Chandrayaan-1 M3 ice](https://jpl.nasa.gov/news/news.php?feature=7218); [LRO ice deposits are widespread](https://science.nasa.gov/solar-system/moon/nasas-lro-lunar-ice-deposits-are-widespread/)
* [Lunar communications and navigation architecture](https://www.nasa.gov/wp-content/uploads/2024/01/lunar-communications-and-navigation-architecture.pdf); [LunaNet](https://www.nasa.gov/communicating-with-missions/lunanet/); [LCRNS](https://www.nasa.gov/goddard/esc/lcrns/); [JPL lunar surface station poster](https://www.jpl.nasa.gov/site/research/media/posters/2024/R24215p.pdf)
* [NASA fission surface power directive, Aug 2025](https://www.nasa.gov/wp-content/uploads/2025/08/nasa-fsp-directive-aug42.pdf)
* [JPL, Perseverance AutoNav](https://www.jpl.nasa.gov/news/nasas-self-driving-perseverance-mars-rover-takes-the-wheel/)

**Not NASA, used in the tool**
* Jun et al., "A Rapid, Low-Cost Path to Lunar Communication and Navigation with a Lunar Surface Station", IEEE Aerospace Conference 2025 (JPL), DOI 10.1109/AERO63441.2025.11068684; ITU-R P.526 (knife-edge diffraction). Both are in the README resource table.

**Things this document does not claim** (we could not confirm them from a primary source on 14 Nov 2026): any named
Artemis IV landing site; a firm launch date for the next CLPS landers; the exact length of Artemis IV's surface stay
(NASA says "approximately a week"); a published landing-ellipse size for the crewed landers; Chang'e-4's planned ellipse.
