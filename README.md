# DevMind — AI Developer and Study Assistant

DevMind is a React, Express, and MongoDB application for project conversations, AI-assisted development, and studying with uploaded materials. It uses Sarvam for language-model responses and Chroma for semantic retrieval.

## Features

- Six developer agents: Planner, Coder, Debugger, Docs, Reviewer, and Tester, with automatic routing or manual selection.
- Streaming chat through Server-Sent Events and conversation history in MongoDB.
- Project workspaces, instructions, tasks, uploaded code files, and project memory.
- Retrieval-augmented generation (RAG) for code and study materials, combining vector search, BM25, and reranking.
- Study plans, quizzes, examinations, progress tracking, and results analysis.
- JWT authentication, bcrypt password hashing, email OTP verification, and password reset.

GitHub connection status has an API endpoint, but an OAuth connection flow is not implemented yet.

## Stack and dependencies

| Component | Technology | Dependency file |
| --- | --- | --- |
| Frontend | React 18, Vite 5, Tailwind CSS, React Router, Axios | `client/package.json` |
| Backend | Node.js, Express, MongoDB/Mongoose, JWT, bcryptjs | `server/package.json` |
| AI | Sarvam (`sarvam-105b-conversations`), using native `fetch` | Configured with `SARVAM_API_KEY` |
| Retrieval | Chroma, local embeddings, local cross-encoder reranker | Node packages in `server/package.json`; local Chroma server in `requirements.txt` |
| Email | Resend HTTP API | Configured with `RESEND_API_KEY` |
| Cache | In-process LRU; optional Redis | `server/package.json` |

`requirements.txt` contains only the Python dependency for a local Chroma server. JavaScript dependencies are installed with npm. Python is unnecessary when using Chroma Cloud.

## Prerequisites

- **Node.js 22.14 or a newer 22.x release**, with npm. Node 18 is insufficient for the current backend dependencies and test runner.
- **Python 3.12** with pip for local Chroma (recommended). The pinned Chroma package declares Python 3.9 or newer.
- A reachable **MongoDB** database, either Atlas or a local instance.
- A **Sarvam API key** with access to the configured model.
- A **Resend API key** and an allowed sender/recipient configuration for OTP emails.

Local embedding and reranking models download on first use. Allow network access and additional startup time. Redis is optional.

## Local setup

### 1. Clone and install JavaScript dependencies

```bash
git clone https://github.com/saikumar33345/devmind.git
cd devmind
npm --prefix server ci
npm --prefix client ci
```

On Windows PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`; for example, `npm.cmd --prefix server ci`.

### 2. Install the local Chroma server

From the project root:

**Windows PowerShell:**

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

**Windows Command Prompt:**

```bat
python -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install -r requirements.txt
```

**macOS / Linux:**

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

See [Chroma client/server documentation](https://docs.trychroma.com/production/chroma-server/client-server-mode) and the [pinned Python package](https://pypi.org/project/chromadb/1.5.9/). With Chroma Cloud, skip this step and configure the Cloud variables below.

### 3. Configure environment variables

Copy `server/.env.example` to `server/.env` and `client/.env.example` to `client/.env`. Keep existing `.env` files if already configured.

**Backend (`server/.env`):**

```env
PORT=5000
MONGODB_URI=mongodb://127.0.0.1:27017/devmind
JWT_SECRET=replace-with-a-long-random-secret
SARVAM_API_KEY=your-sarvam-api-key
RESEND_API_KEY=your-resend-api-key
RESEND_FROM_EMAIL=DevMind <onboarding@resend.dev>
SKIP_OTP_VERIFICATION=false
CLIENT_URL=http://localhost:5173
```

Use your Atlas connection string instead of the local MongoDB URI if applicable. Configure a verified Resend sender when sending to recipients beyond those allowed by the default sender.

| Optional variable | Purpose |
| --- | --- |
| `CHROMA_HOST`, `CHROMA_PORT` | Local Chroma address; defaults to `localhost:8000` |
| `CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE` | Chroma Cloud credentials; setting the API key selects Cloud |
| `RERANKER_PROVIDER` | `local` (default) loads the cross-encoder; `llm` uses Sarvam instead |
| `REDIS_URL` | Shared Redis cache; omit to use the in-process cache |
| `CONTACT_NOTIFY_EMAIL` | Recipient for optional contact-form email notifications |

Keep `SKIP_OTP_VERIFICATION=false` for normal authentication. Setting it to `true` bypasses signup/login OTP checks for local development. Password-reset emails still require Resend.

**Frontend (`client/.env`):**

```env
VITE_API_URL=http://localhost:5000/api
```

Claude/OpenAI keys are not used by the current implementation. Changing providers requires a code change in `server/src/utils/llm.js`.

### 4. Start the services

Use three terminals from the project root.

**Terminal 1 — Chroma (PowerShell):**

```powershell
.\.venv\Scripts\chroma.exe run --path ./server/chroma_data --port 8000
```

With the virtual environment activated on Command Prompt, macOS, or Linux, you can instead run:

```bash
npm --prefix server run chroma
```

**Terminal 2 — backend:**

```bash
npm --prefix server run dev
```

**Terminal 3 — frontend:**

```bash
npm --prefix client run dev
```

Open **http://localhost:5173**. The backend health endpoint is **http://localhost:5000/**. Wait for Chroma before uploading files or using retrieval. Backend health alone does not check Chroma, Sarvam, or email delivery.

With Chroma Cloud, only the backend and frontend terminals are needed.

The Windows helpers `install.bat` and `run.bat` install/start the same services. Activate your Python environment in Command Prompt first so `pip` and `chroma` are on PATH. `run.bat` opens three service windows.

## Checks

```bash
# Backend unit tests
npm --prefix server test

# Frontend production build
npm --prefix client run build
```

For a full smoke check, confirm MongoDB connects, open the landing and authentication pages, sign up with an email that can receive OTPs, create a project, send a chat message, and upload study material or a code file. Unit tests and a frontend build do not prove external credentials or email delivery work.

## Project structure

```text
devmind/
├── client/
│   ├── src/
│   │   ├── api/             # Backend API clients
│   │   ├── components/      # Chat, dashboard, study, exam, and shared UI
│   │   ├── context/         # Authentication and project state
│   │   ├── pages/           # Application routes
│   │   └── utils/
│   ├── .env.example
│   └── package.json
├── server/
│   ├── src/
│   │   ├── agents/          # Developer, study, exam, and results agents
│   │   ├── controllers/
│   │   ├── middleware/
│   │   ├── models/          # MongoDB schemas
│   │   ├── rag/             # Retrieval pipeline and evaluation tools
│   │   ├── routes/
│   │   ├── utils/           # LLM, Chroma, email, parsing, and cache helpers
│   │   └── server.js
│   ├── .env.example
│   └── package.json
├── requirements.txt         # Python Chroma server dependency
├── install.bat
└── run.bat
```

Local `.env` files, `node_modules`, uploads, Chroma data, and Python environments are excluded from Git.

## Deployment

- Build with `npm --prefix client run build` and deploy `client/dist` to a static host. Configure SPA fallback; `client/vercel.json` provides Vercel rewrites.
- Set `VITE_API_URL` to the deployed backend's `/api` URL before building.
- Run the backend with `npm --prefix server start` on a host with the supported Node version. Configure its environment variables and MongoDB connectivity.
- Set `CLIENT_URL` to the frontend origin for CORS.
- Configure Chroma Cloud or a reachable Chroma server. File retrieval requires Chroma even when ordinary chat works.
- Uploads use local disk under `server/uploads`; use persistent storage to preserve them across redeployments.
- The default local reranker needs memory and a first-run model download. `RERANKER_PROVIDER=llm` selects Sarvam-based reranking.
- Redis is optional; configure it when backend instances need a shared cache.
