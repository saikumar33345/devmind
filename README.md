# DevMind

An AI assistant for software projects and studying from uploaded materials.

## Features

- Project chats with Planner, Coder, Debugger, Docs, Reviewer, and Tester agents.
- Project files, tasks, instructions, and saved project context.
- Study plans, quizzes, exams, and progress tracking.
- Email verification, password reset, and conversation history.

## Stack

| Area | Technology |
| --- | --- |
| Frontend | React, Vite, Tailwind CSS |
| Backend | Node.js, Express |
| Database and file storage | MongoDB, Mongoose, GridFS |
| Vector search | Qdrant |
| AI responses | Sarvam |
| Email | Resend |

## Setup

Requires Node.js 22.14 or later in the 22.x series, npm, and accounts for MongoDB Atlas, Qdrant Cloud, Sarvam, and Resend.

```bash
git clone https://github.com/saikumar33345/devmind.git
cd devmind
npm --prefix server ci
npm --prefix client ci
```

Copy `server/.env.example` to `server/.env` and `client/.env.example` to `client/.env`. Keep existing environment files if they are already configured.

On Windows, use `npm.cmd` if PowerShell blocks `npm`. You can also run `install.bat` to install the JavaScript dependencies.

### Environment variables

Configure these values in `server/.env`:

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string, including the database name |
| `JWT_SECRET` | A long, random secret for login tokens |
| `SARVAM_API_KEY` | Sarvam API key |
| `RESEND_API_KEY` | Resend API key |
| `RESEND_FROM_EMAIL` | An allowed Resend sender |
| `QDRANT_URL` | Qdrant cluster REST endpoint |
| `QDRANT_API_KEY` | Qdrant API key with read/write access |
| `CLIENT_URL` | Frontend origin; `http://localhost:5173` locally |

`QDRANT_COLLECTION` defaults to `devmind_chunks`. Collections are created automatically. MongoDB stores the application data and uploaded files; Qdrant stores the searchable text chunks and vectors.

Keep `SKIP_OTP_VERIFICATION=false` for normal email verification. Redis is optional; leave `REDIS_URL` empty to use the in-process cache.

The frontend reads its API address from `client/.env`:

```env
VITE_API_URL=http://localhost:5000/api
```

### Run locally

Start the backend and frontend in separate terminals:

```bash
npm --prefix server run dev
```

```bash
npm --prefix client run dev
```

Open `http://localhost:5173`. On Windows, `run.bat` opens both services in separate terminals.

Embeddings run locally in the backend. Local development downloads the model on first use; the Docker build downloads and verifies it before deployment. The default reranker also runs locally. Set `RERANKER_PROVIDER=llm` to use Sarvam for reranking instead.

## Commands

Run these commands from the repository root:

| Command | Purpose |
| --- | --- |
| `npm --prefix server test` | Run backend tests |
| `npm --prefix server run prepare:embeddings` | Download and verify the embedding model |
| `npm --prefix server run check:qdrant` | Check the Qdrant connection without changing data |
| `npm --prefix client run build` | Build the frontend |
| `npm --prefix server start` | Start the backend without file watching |

## Deployment

### Render

Create a Blueprint from `render.yaml`. It builds the backend from `server/Dockerfile` using Node.js 22 and the free compute plan.

Supply the prompted environment variables and allow the service's outbound IP ranges in Atlas Network Access. Set `CLIENT_URL` to the Vercel production origin, without a trailing slash.

The Blueprint uses `RERANKER_PROVIDER=llm`. Embeddings still run in the backend. Uploaded files persist in Atlas through GridFS and count toward the database's storage quota.

### Vercel

Import the same repository with these settings:

| Setting | Value |
| --- | --- |
| Root directory | `client` |
| Framework | Vite |
| Node.js version | 22.x |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |

Set `VITE_API_URL` to the Render backend URL followed by `/api`, then redeploy. Keep API keys and database credentials in Render. `client/vercel.json` handles frontend routes.

## Project structure

```text
devmind/
|-- client/
|   |-- public/
|   |-- src/
|   |   |-- api/
|   |   |-- components/
|   |   |-- context/
|   |   |-- pages/
|   |   `-- utils/
|   |-- .env.example
|   `-- package.json
|-- server/
|   |-- scripts/
|   |-- src/
|   |   |-- agents/
|   |   |-- config/
|   |   |-- controllers/
|   |   |-- middleware/
|   |   |-- models/
|   |   |-- rag/
|   |   |-- routes/
|   |   `-- utils/
|   |-- .env.example
|   |-- Dockerfile
|   `-- package.json
|-- install.bat
|-- render.yaml
|-- requirements.txt
`-- run.bat
```

## Local Chroma (optional)

The backend also supports a local Chroma server when `QDRANT_URL` and `QDRANT_API_KEY` are unset. Python is only needed for this option.

```bash
python -m pip install -r requirements.txt
npm --prefix server run chroma
```

The default address is `localhost:8000`. Use `CHROMA_HOST` and `CHROMA_PORT` to change it. Local Chroma data stays separate from Qdrant.
