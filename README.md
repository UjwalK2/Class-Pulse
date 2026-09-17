# 📡 ClassPulse

**Real-time classroom confusion detection & AI-powered adaptive teaching support.**

[Live Demo](#) · [Report an Issue](#)

---

## The Problem

Teachers ask "does everyone understand?" and get met with silence — not because students understand, but because nobody wants to be the one who admits they're lost. Confusion compounds silently for the rest of the class, and the teacher only finds out when homework or exam results come back, days or weeks later. By then, the moment to actually fix it is long gone.

## The Solution

ClassPulse turns silent classroom confusion into a live, anonymous feedback signal the teacher can act on **in the moment**, not after the exam.

- Students tap **Got It / Kinda / Lost** on their phones during the lecture — completely anonymous.
- The teacher sees a **live comprehension graph**, updating in real time as the class responds.
- If confusion spikes past a threshold, **Gemini AI instantly generates** a simple analogy and a 2-option diagnostic question targeting the exact misconception.
- The teacher pushes it to every student's phone with one click, gets an instant read on exactly where the class is stuck, and can adjust the lecture on the spot.

## Features

- 🔗 **Zero-friction onboarding** — students join via QR code, no login or app download required
- 📊 **Live retention curve** — a real-time graph of class-wide comprehension, powered by a 60-second sliding window
- ✋ **Hold-to-confirm "Lost" button** — prevents spam taps and trolling, ensures intentional, clean signal data
- 🤖 **AI-generated interventions** — Gemini creates a teaching analogy and a targeted A/B diagnostic question the instant confusion spikes
- ⚡ **Instant push to class** — one click sends the diagnostic question live to every connected student device
- 📈 **Post-class summary** — a session heatmap showing exactly which moments/topics caused the most confusion

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React (Vite) + Tailwind CSS + Recharts + Lucide Icons |
| Backend / Data | Firebase Firestore (real-time sync) |
| AI | Gemini API (structured JSON mode) |
| Hosting | Firebase Hosting |

## Screenshots

![Teacher Dashboard](./screenshots/teacher-dashboard.png)
![Student View](./screenshots/student-dashboard.png)
![AI Intervention](./screenshots/intervention.png)

## How It Works

1. Teacher opens the app and a session QR code is generated instantly.
2. Students scan the QR code and land directly on the response screen — no setup.
3. As the lecture goes on, students tap their comprehension level; each signal is written to Firestore in real time.
4. A sliding-window algorithm continuously aggregates the last 60 seconds of responses into a live confusion score.
5. When confusion crosses the threshold, Gemini generates an analogy + diagnostic question for the exact topic being taught.
6. The teacher pushes it live; students answer; the teacher instantly sees exactly what's misunderstood and can course-correct on the spot.

## Getting Started (Run Locally)

```bash
# Clone the repo
git clone https://github.com/hemanth1914-stack/Class-Pulse.git
cd Class-Pulse

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Fill in your Firebase config and Gemini API key in .env

# Run the dev server
npm run dev
```

## Environment Variables

Create a `.env` file in the root directory with the following (see `.env.example`):

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_GEMINI_API_KEY=
```


## License

This project is licensed under the MIT License — see the [LICENSE](./LICENSE) file for details.
