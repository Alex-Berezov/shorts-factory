# Current Status & Next Steps

_As of 2026-09-05_

This is the fastest orientation document. Read this first when returning to the project.

## 1. What has been decided

- Build an internal AI-assisted Shorts production/analytics application.
- Use one global YouTube channel.
- Use **English as the canonical/master language**.
- Final target after tooling: **2 Shorts/day**.
- Initial formal validation period: **90 days / ~180 Shorts**.
- Target multilingual coverage: **10–20 languages**.
- Manual editing remains in CapCut initially.
- Competitor videos are analyzed deeply (speech + visuals + structure), but our factual research and final scripts remain original.
- **Experiment Engine is mandatory**.
- The channel brand will use an **original fictional creature**, not a goose or generic animal mascot.
- The app may later become SaaS, but it is internal-first.

## 2. YouTube setup status

### Confirmed

- Phone verification completed.
- Intermediate Features = **Enabled**.
- Advanced Features = **Eligible**, not yet Enabled.
- YouTube currently requires Channel History.
- ID/video verification pages are unavailable in the current location.
- **Automatic Dubbing is already available in channel settings.**
- Automatic Dubbing is enabled.
- Manual dub review is enabled.

### Important implication

We do **not** need to wait for Advanced Features before starting development or multilingual testing.

## 3. Immediate channel strategy

While the application is being built:

- publish **4–7 real English Shorts/week**;
- ideal cadence if comfortable: ~1/day;
- do not force 2/day yet;
- set original language to English;
- let YouTube generate automatic dubs;
- initially review all dubs before publishing if the setting is available;
- manually note quality per language;
- periodically check whether Advanced Features become Enabled.

## 4. Next concrete action

Create and publish the **first real English Short** in the target format.

Then:

1. Open the Short in YouTube Studio.
2. Open **Languages**.
3. See which automatic dubs were generated.
4. Listen to several major languages.
5. Record quality/timing observations.
6. Keep this as the baseline for future custom TTS comparison.

## 5. Development can start now

Recommended first development block:

1. Source Radar
2. YouTube public stats snapshots
3. velocity/anomaly scoring
4. Gemini public-URL video analysis
5. transcript + visual timeline
6. Content DNA
7. Idea Inbox

Then:

8. Research Agent
9. Script Engine
10. Production Package
11. YouTube Analytics integration
12. Experiment Engine
13. Custom localization/TTS
14. Publishing automation

## 6. Advanced Features future test

Once Advanced Features switch to **Enabled**:

- open YouTube Studio -> Languages;
- select a Short;
- Add language;
- test **Dub -> Add** with our own audio file;
- if an auto-dub exists for that language, delete it first;
- confirm manual Multi-Language Audio works on the channel.

## 7. Current brand status

- `ROVUNI / @rovuni` is occupied -> rejected.
- Current candidates being checked manually:
  - Vezoki
  - Nivoko
  - Pevori
  - Mavoki
  - Zavumi
  - Vunelo
  - Kivumo
  - Tavoki
  - Lomavi
  - Zuviro
- Final mascot visual design is intentionally postponed until the exact channel name/handle is reserved.

## 8. Current highest-value technical discovery

Gemini API can process a **public YouTube URL** and analyze video/audio with timestamps. This enables a direct competitor-intelligence flow:

> public Short URL -> semantic transcript -> visual timeline -> hook analysis -> Content DNA -> correlation with view velocity.

This means the system can analyze not only what a creator says, but what is shown in the first seconds and how narration/visuals combine.

## 9. Budget/time assumptions

- manual effort target after automation: <=15h/week;
- 3-month tool/API test budget: roughly $500–700;
- do not hire an editor during validation;
- custom TTS is no longer a first-day requirement because YouTube Auto Dubbing can be used as a baseline.
