<!-- Improved compatibility of back to top link: See: https://github.com/othneildrew/Best-README-Template/pull/73 -->
<a id="readme-top"></a>

[![Contributors][contributors-shield]][contributors-url]
[![Issues][issues-shield]][issues-url]
[![License][license-shield]][license-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <h3 align="center">DiaGuru</h3>

  <p align="center">
    Intelligent daily planner that captures what is on your mind, parses the intent, and arranges your Google Calendar automatically.
    <br />
    <a href="https://github.com/realjbgunner24/DiaGuru/issues/new?labels=bug&template=bug-report---.md">Report Bug</a>
    &middot;
    <a href="https://github.com/realjbgunner24/DiaGuru/issues/new?labels=enhancement&template=feature-request---.md">Request Feature</a>
  </p>
</div>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#configuration">Configuration</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#testing">Testing</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

## About The Project

DiaGuru helps you capture everything on your mind, estimate effort, and turn it into a realistic plan inside Google Calendar. The app combines a lightweight capture experience with automatic parsing (Duckling + regex), Supabase-backed storage, and a scheduling engine that respects quiet hours, buffers, and your existing events.

Core capabilities today:

- Email/password auth with Supabase and Expo Router guarded routes.
- Capture queue stored in Supabase with priority scoring and status transitions.
- Google Calendar link/unlink flow with secure token storage and reconciliation of DiaGuru-created events.
- Dual parsing modes:
  - **Deterministic** prompts you for any missing fields (duration, importance, etc.).
  - **Conversational** asks DeepSeek one clarifying question when information is ambiguous.
- Greedy scheduling Edge Function that finds the earliest valid slot (8am–10pm, 30-minute buffers) and writes events tagged with `[DG]`.
- Local and push notification helpers to remind you when sessions complete and collect follow-up feedback.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

* [![Expo][expo-shield]][expo-url]
* [![React Native][react-native-shield]][react-native-url]
* [![TypeScript][typescript-shield]][typescript-url]
* [![Supabase][supabase-shield]][supabase-url]
* [![Deno][deno-shield]][deno-url]
* [![Fly.io][fly-shield]][fly-url]
* [![Duckling][duckling-shield]][duckling-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Getting Started

Follow these steps to run DiaGuru locally and deploy supporting services.

### Prerequisites

- Node.js 18+ and npm 9+.
- Expo CLI (`npm install -g expo-cli`) or use `npx expo`.
- Supabase CLI (`npm install -g supabase`) for functions and secrets.
- Deno 1.40+ for local Edge Function development.
- Docker (optional) if you want to run Duckling locally instead of Fly.io.

### Installation

1. Clone the repository
   ```bash
   git clone https://github.com/realjbgunner24/DiaGuru.git
   cd DiaGuru
   npm install
   ```
2. (Optional) Launch Duckling locally  
   ```bash
   docker run --rm -p 8000:8000 rasa/duckling
   ```
   or provision the Fly.io app (`dia-guru.fly.dev`).

### Configuration

Copy `.env.example` to `.env` and provide the values listed below. Expo loads this file automatically.

| Variable | Description |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID` | Web OAuth client for Google Calendar |
| `EXPO_PUBLIC_GOOGLE_REDIRECT_URI` | URL of the deployed OAuth callback Edge Function |

Edge Function secrets (set via `supabase secrets set`):

| Variable | Description |
| --- | --- |
| `SERVICE_ROLE_KEY` | Allows secure access to token tables |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Match the Expo app credentials |
| `GOOGLE_REDIRECT_URI` | Same as the public redirect URI above |
| `DUCKLING_URL` | `https://dia-guru.fly.dev/parse` (or your local container) |
| `LOCALE` / `TZ` | Defaults `en_US` / `America/Chicago` |
| `WORK_END` | Latest preferred finish time (e.g., `17:30`) |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Optional DeepSeek config for conversational parsing |

Deploy or update a function:
```bash
supabase functions deploy parse-task
supabase functions deploy schedule-run
```

Run the mobile app:
```bash
npx expo start
```
Scan the QR code with Expo Go or start an emulator/simulator.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Usage

1. Sign up or log in from the Auth flow. Sessions are persisted with Supabase.
2. Link Google Calendar from the Account tab and confirm the `[DG]` tags appear for DiaGuru-created events.
3. Capture anything that’s on your mind. Depending on Settings → Assistant Mode, the app will either prompt for missing fields or ask a DeepSeek-powered clarifying question.
4. The scheduling Edge Function:
   - Pulls captures by priority.
   - Queries Google Calendar, applies buffers/quiet hours, and books events.
   - Marks captures with `calendar_event_id`, `planned_for`, and status.
5. When an event finishes, DiaGuru triggers a reminder to confirm completion or reschedule.

Use the Settings tab to test immediate and scheduled notifications, or to toggle the assistant mode.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Testing

DiaGuru ships with Jest + React Native Testing Library for Expo components and Deno tests for Edge Functions.

```bash
npm run test            # Jest suites (lib and screens)
npm run lint            # ESLint (optional in CI)
npm run typecheck       # tsc --noEmit
npm run deno:lint       # Deno lint for Edge Functions
npm run deno:test       # Deno unit tests
npm run validate        # typecheck + Jest + Deno (CI default)
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Roadmap

- [x] Capture parsing with Duckling + regex fallback.
- [x] Deterministic vs conversational parsing modes.
- [x] Greedy scheduler that respects buffers, quiet hours, and existing events.
- [ ] DeepSeek-guided reasoning for rescheduling and conflict resolution.
- [ ] OR-Tools microservice for advanced constraint handling.
- [ ] Personalized heuristics that learn from completion history.
- [ ] Push notification cadence tuned to user preferences.

See the [open issues](https://github.com/realjbgunner24/DiaGuru/issues) for the full backlog.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contributing

This project is currently closed to outside contributions while the core experience stabilizes. If you spot a bug or want to propose an enhancement, please open an issue first so we can coordinate the work.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## License

Distributed under a private license. Contact the maintainers for reuse permissions.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contact

Project Link: [https://github.com/realjbgunner24/DiaGuru](https://github.com/realjbgunner24/DiaGuru)

Have questions? Open a discussion or ping us through the repo issues.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Acknowledgments

* [Best README Template](https://github.com/othneildrew/Best-README-Template) for the structure.
* [Rasa Duckling](https://github.com/facebook/duckling) for low-latency date parsing.
* [Supabase](https://supabase.com) for auth, storage, and Edge Functions.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/realjbgunner24/DiaGuru.svg?style=for-the-badge
[contributors-url]: https://github.com/realjbgunner24/DiaGuru/graphs/contributors
[issues-shield]: https://img.shields.io/github/issues/realjbgunner24/DiaGuru.svg?style=for-the-badge
[issues-url]: https://github.com/realjbgunner24/DiaGuru/issues
[license-shield]: https://img.shields.io/badge/license-Private-lightgrey?style=for-the-badge
[license-url]: https://github.com/realjbgunner24/DiaGuru
[expo-shield]: https://img.shields.io/badge/Expo-1B1F23?style=for-the-badge&logo=expo&logoColor=fff
[expo-url]: https://expo.dev
[react-native-shield]: https://img.shields.io/badge/React%20Native-20232A?style=for-the-badge&logo=react&logoColor=61DAFB
[react-native-url]: https://reactnative.dev
[typescript-shield]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[typescript-url]: https://www.typescriptlang.org/
[supabase-shield]: https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=black
[supabase-url]: https://supabase.com
[deno-shield]: https://img.shields.io/badge/Deno-000000?style=for-the-badge&logo=deno&logoColor=white
[deno-url]: https://deno.land
[fly-shield]: https://img.shields.io/badge/Fly.io-100F1F?style=for-the-badge&logo=flydotio&logoColor=white
[fly-url]: https://fly.io
[duckling-shield]: https://img.shields.io/badge/Duckling-FFD166?style=for-the-badge&logo=duckduckgo&logoColor=000
[duckling-url]: https://github.com/facebook/duckling
