# AI Shorts Factory — Architecture & Product Blueprint

_Last updated: 2026-09-05_

## 1. Product goal

Build an internal-first application that turns YouTube trend discovery into a repeatable multilingual Shorts production system.

The human should ideally spend time on only three things:

1. Approve/reject promising story ideas.
2. Make the final manual edit in CapCut (initial phase).
3. Review publishing quality and strategic analytics.

Everything else should be automated or semi-automated: competitor monitoring, trend detection, whole-video AI analysis, speech/transcript analysis, visual analysis, idea extraction, independent research, script generation, experiment design, localization, dubbing/TTS, metadata, publishing support, statistics ingestion and AI analytics.

---

## 2. Current launch strategy

- Publishing model: **one global YouTube channel**.
- Canonical/master language: **English**.
- Initial manual publishing cadence while the app is being built: **4–7 real English Shorts/week**, ideally ~1/day if sustainable.
- Target cadence once the pipeline is ready: **2 Shorts/day**.
- Formal MVP test duration: **90 days**.
- Formal MVP test volume: **~180 Shorts** at 2/day.
- Language ambition: **10–20 languages**.
- Current localization bridge: **YouTube Automatic Dubbing** is already available on the channel.
- Long-term localization target: custom localized scripts + controlled TTS/custom dub tracks where YouTube Multi-Language Audio permits manual uploads.
- Manual workload target after automation: **<=15 hours/week**.
- Initial 3-month operating budget target: **~$500–700**, excluding developer time.

Important: the channel is already able to use Automatic Dubbing, even though Advanced Features are not yet fully enabled. Therefore lack of Advanced Features is **not a blocker for development or initial multilingual testing**.

---

## 3. Content principle: analyze, do not clone

Competitor videos are intelligence inputs, not scripts to rewrite sentence-by-sentence.

We *do* want to analyze the actual spoken text and visual sequence because titles/descriptions are insufficient to explain why a Short performs well.

For each reference Short the system should analyze:

- exact story/topic and subtopic;
- semantic transcript and narration structure;
- first 1/2/3/5 seconds of speech;
- wording patterns and rhetorical devices;
- sentence length and narration pace;
- hook type;
- curiosity gap / open loop;
- order in which facts are revealed;
- reveal/payoff timing;
- ending style;
- visual hook;
- first frames and scene sequence;
- object/person shown at the beginning;
- text overlays;
- approximate editing rhythm and scene-change density;
- relation between narration and visuals;
- emotional driver;
- performance velocity;
- transferable abstract patterns.

The output should be a reusable **Content DNA**, not a near-verbatim derivative script.

Preferred generation pattern:

**Competitor video -> understand why it works -> independent research -> factual brief -> original master script -> original edit.**

---

## 4. High-level pipeline

```text
Tracked Channels
      ↓
YouTube Data API sync
      ↓
New video detection
      ↓
Public statistics snapshots
      ↓
Velocity / acceleration / anomaly scoring
      ↓
Gemini whole-video analysis by public YouTube URL
      ↓
Transcript + visual timeline + Hook Analysis
      ↓
Content DNA extraction
      ↓
Competitor Intelligence DB
      ↓
AI correlation / cluster analysis
      ↓
TODAY'S IDEAS
      ↓
Human: Approve / Reject / Later
      ↓
Independent research + fact verification
      ↓
Master English script
      ↓
Production package / shot list
      ↓
Human CapCut edit
      ↓
Publish English master
      ↓
YouTube Automatic Dubbing (current bridge)
      ↓
Later: custom localization + custom TTS + Multi-Language Audio
      ↓
YouTube Analytics ingestion
      ↓
Experiment Engine
      ↓
Learnings feed back into idea selection and script generation
```

---

## 5. Main modules

### 5.1 Source Radar

Purpose: monitor competitor/inspiration channels and detect content that is accelerating unusually fast.

Core entities:

- `tracked_channel`
- `tracked_video`
- `video_stats_snapshot`
- `trend_signal`
- `story_cluster`

Functions:

- add/remove tracked channels;
- sync new uploads;
- store public video metadata;
- periodically snapshot views/likes/comments;
- calculate views/hour;
- calculate acceleration/deceleration;
- compare each video to that creator's historical baseline;
- detect the same or similar story across multiple channels;
- rank emerging topics.

Suggested best-effort snapshot points for new videos:

- 1h
- 3h
- 6h
- 12h
- 24h
- 48h
- 7d

Exact scheduling can later be optimized based on API quota and observed usefulness.

---

### 5.2 Video Intelligence / Content DNA

Primary input: **public YouTube URL**.

Gemini can analyze public YouTube videos directly and reason over both video and audio with timestamps. This lets us avoid making title/description the primary understanding source.

Structured JSON output should include at minimum:

- `topic`
- `subtopic`
- `story_summary`
- `semantic_transcript`
- `timeline[]`
- `hook_type`
- `hook_text_pattern`
- `opening_visual_type`
- `first_visual_object`
- `first_1s_analysis`
- `first_2s_analysis`
- `first_3s_analysis`
- `first_5s_analysis`
- `context_delay_sec`
- `open_loop_type`
- `reveal_timestamp_sec`
- `reveal_pct`
- `story_structure`
- `emotional_driver`
- `speech_pace`
- `sentence_style`
- `visual_change_density`
- `text_overlay_usage`
- `face_presence`
- `ending_type`
- `cta_type`
- `why_it_may_work[]`
- `transferable_patterns[]`
- `risky_to_copy_elements[]`

For high-priority winners, run a second **Hook Analysis Pass** focused on 0–5 seconds.

For our own local video files, allow a higher-detail analysis mode (e.g. denser frame sampling) when needed.

---

### 5.3 Idea Inbox

Daily ranked queue of candidate stories.

Card fields:

- idea title;
- story summary;
- source reference videos;
- current velocity score;
- acceleration score;
- multi-channel story-cluster score;
- why now;
- suggested research sources;
- proposed hooks;
- target duration;
- category/subcategory;
- confidence/opportunity score;
- possible visual treatment;
- buttons: **Approve / Reject / Later**.

---

### 5.4 Research Agent

Runs after approval, or automatically for highest-scoring candidates.

Tasks:

- find independent sources;
- verify names, dates, numbers and sequence of events;
- separate confirmed facts from uncertain claims;
- generate a factual brief;
- store source links;
- flag contradictions;
- flag legal/copyright/safety concerns;
- produce a concise list of claims allowed into the script.

Important: competitor narration is useful for **presentation analysis**, but factual claims should be independently verified where practical.

---

### 5.5 Script Engine

Canonical output language: **English**.

Produces:

- 3–5 hook variants;
- master script;
- target duration;
- hook -> setup -> escalation -> reveal/payoff -> ending structure;
- optional CTA only when justified;
- language-neutral visual assumptions where possible;
- experiment tags describing the script strategy.

Store all script versions for later correlation with performance.

---

### 5.6 Production Package

For each approved Short:

- final master script;
- second-by-second narration timeline;
- shot list;
- visual suggestions;
- source/media checklist;
- text-overlay suggestions;
- SFX/music notes;
- target duration;
- editing rhythm notes;
- explicit hook and reveal timestamps;
- experiment hypothesis.

Initial rule: **CapCut editing remains manual**.

---

### 5.7 Localization Layer

There are now two localization modes.

#### Mode A — YouTube Automatic Dubbing (available now)

Use during the early channel-history period and as a baseline/control.

Flow:

- publish English master;
- set original language correctly to English;
- let YouTube generate automatic dubs;
- manually review dubs before publishing during the test phase;
- measure which languages receive distribution and how quality varies.

Advantages:

- zero custom TTS production work;
- immediate multilingual testing;
- no need to wait for Advanced Features;
- useful benchmark against our future custom localization.

Limitations:

- auto-dubs cannot be manually edited;
- quality differs by language;
- names, slang, idioms and fast speech can create errors;
- exact voice/persona is not under our control.

#### Mode B — Custom Localization Factory (long-term)

For each target language:

- localize rather than translate literally;
- preserve facts and reveal timing;
- adapt hook/rhythm/idioms to native audience;
- fit target duration tolerance (e.g. ±2 sec);
- generate localized title/description/hashtags;
- generate captions;
- QA against the master factual brief.

When manual Multi-Language Audio becomes available, custom dub tracks can replace auto-dubs. If YouTube already created an automatic dub for a language, it must be removed before uploading a custom track for that language.

---

### 5.8 Voice Factory

Provider abstraction so the TTS backend can be switched per language and quality/cost can be A/B tested.

Candidates:

- ElevenLabs
- Gemini TTS
- Google Chirp 3 HD
- Cartesia Sonic
- OpenAI TTS
- YouTube Automatic Dubbing (treated as a native-platform baseline, not an API TTS provider)

Per language/store:

- preferred narrator voice;
- provider/model;
- voice instructions;
- speaking rate;
- cost;
- generation attempts;
- final file path;
- QA status.

Do not select a permanent TTS provider before doing a multilingual bake-off on representative scripts.

---

### 5.9 Publishing Layer

Automate where officially supported:

- upload video;
- schedule publication;
- localized metadata;
- captions;
- publishing status;
- analytics identifiers.

Current known limitation:

- YouTube Data API does not expose a documented public endpoint for uploading additional manual Multi-Language Audio dub tracks.
- Therefore the app should prepare correctly named custom audio files and support a manual Studio step unless/until YouTube exposes an API.

Current practical path:

1. English master is uploaded/published.
2. Automatic Dubbing is currently available and can generate language tracks.
3. Later, once Advanced Features are enabled, test manual custom dubbing under **Languages**.

---

### 5.10 Analytics Warehouse

Own-channel data via YouTube Analytics API.

Collect where available by video/day/country/other supported dimensions:

- views;
- engagedViews;
- averageViewDuration;
- averageViewPercentage where supported by report;
- estimatedMinutesWatched;
- likes;
- comments;
- shares;
- subscribersGained;
- subscribersLost;
- estimatedRevenue after monetization and appropriate scopes;
- country/language-related distribution signals where available.

Competitor/public data via YouTube Data API:

- publish time;
- title/description;
- duration;
- views;
- likes;
- comments;
- snapshots over time.

---

### 5.11 Experiment Engine — mandatory

Every Short gets structured experiment features, for example:

- topic/subtopic;
- hook_type;
- opening_visual_type;
- result_first true/false;
- context_delay_sec;
- reveal_pct;
- duration;
- story_structure;
- narrator voice/provider;
- cuts_per_10_sec;
- has_face;
- has_big_text;
- ending_type;
- source_type;
- dominant emotion;
- auto-dub vs custom-dub;
- localization strategy;
- publish day/time;
- visual origin/style.

The engine should:

- compare winners vs losers;
- identify correlations;
- compare the same creator's winners and losers;
- compare our own experiments;
- recommend controlled next experiments;
- detect when a topic/category is gaining or losing momentum;
- surface confidence, not just simplistic causal claims.

Example recommendation:

> In the last 30 Shorts, result-first openings outperformed context-first openings on median 24h views. Run the next 10 videos as 5/5 controlled variants while holding duration and topic type as constant as practical.

---

## 6. Channel-history phase (current)

Current confirmed YouTube state as of 2026-09-05:

- phone verification: **completed**;
- Intermediate Features: **Enabled**;
- Advanced Features: **Eligible, not Enabled**;
- YouTube currently requires **Channel history** for this channel;
- ID/video verification is **unavailable in the user's current location**;
- Automatic Dubbing setting is **already available**;
- Automatic Dubbing is enabled;
- manual review of dubs is enabled.

Therefore:

- do **not** wait for Advanced Features before developing;
- publish real English Shorts while development is underway;
- use Automatic Dubbing as a real multilingual test;
- periodically re-check Feature Eligibility;
- once Advanced Features become Enabled, immediately test manual Multi-Language Audio/custom dub upload.

YouTube says active compliant channels can typically build sufficient channel history within roughly two months, but this is not a guaranteed fixed timer.

---

## 7. Recommended implementation order

### Phase 0 — Channel + live experiment

- set English as canonical/original language;
- publish 4–7 real Shorts/week while app is built;
- keep Automatic Dubbing on;
- switch initial review policy to review all languages if possible;
- inspect generated dubs and language quality;
- collect first real analytics manually if needed.

### Phase 1 — Intelligence core

- tracked channels;
- YouTube API sync;
- stats snapshots;
- velocity/anomaly scoring;
- Gemini whole-video analysis;
- Content DNA;
- Idea Inbox.

### Phase 2 — Production core

- Research Agent;
- factual brief;
- Script Engine;
- Production Package;
- experiment tags.

### Phase 3 — Analytics + Experiment Engine

- own-channel OAuth;
- YouTube Analytics ingestion;
- dashboard;
- winner/loser analysis;
- recommendation engine.

### Phase 4 — Multilingual production

- localization factory;
- TTS provider abstraction;
- custom captions/metadata;
- custom dub package;
- compare custom output to YouTube auto-dub.

### Phase 5 — Publishing automation

- upload/scheduling where API supports it;
- localization metadata;
- captions;
- manual custom-audio handoff unless an official audio-track API appears.

---

## 8. SaaS readiness

The application is **internal-first**. Do not optimize for external customers before the system proves value on our own channel.

Potential later SaaS surface:

- competitor radar;
- trend/velocity alerts;
- whole-video analysis;
- Content DNA;
- idea inbox;
- research/scripts;
- localization/TTS;
- analytics;
- Experiment Engine.

Potential private/internal advantage to keep ahead of customers:

- proprietary scoring weights;
- source lists;
- benchmarks;
- learned correlations;
- best prompts/analysis recipes;
- production playbooks derived from our own channel data.

---

## 9. Current official references

- Automatic dubbing: https://support.google.com/youtube/answer/15569972
- Multi-Language Audio: https://support.google.com/youtube/answer/13338784
- Feature access / Advanced Features: https://support.google.com/youtube/answer/9891124
- Feature access table: https://support.google.com/youtube/answer/9890437
- YouTube Analytics metrics: https://developers.google.com/youtube/analytics/metrics
- Gemini video understanding: https://ai.google.dev/gemini-api/docs/video-understanding
