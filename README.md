# LocalLens

LocalLens is a privacy-first, locally-deployable browser automation agent. It bridges a Chrome MV3 extension with a Vision-Language Model (VLM) backend to autonomously execute natural language tasks on any webpage (e.g., "Submit the login form").

## 🏗️ Architecture

The system is split into a robust frontend extension and an intelligent Python backend:

### 1. Browser Extension (Frontend)
- **Content Script (`content.ts`)**: Runs on the webpage. Walks the DOM, identifies interactive elements, stamps them with stable `data-agent-id` tags, calculates bounding boxes, and **redacts PII** (emails, cards, SSNs) client-side before it ever leaves the browser. It also acts as the actuator, executing clicks and typing based on backend commands.
- **Background Worker (`background.js`)**: The secure relay. It captures visible tab screenshots and relays messages between the popup and the content script.
- **Popup (`agentLoop.ts`)**: The orchestration brain. It fetches the UI Graph context from the content script, packages it with a screenshot, sends it to the backend via WebSocket/REST, and routes the returned actions back to the content script for execution.

### 2. FastAPI Backend
- **Action Planner (`action_planner.py`)**: Receives the current browser context (UI Graph + Screenshot) and session history.
- **LLM Client (`llm_client.py`)**: Prompts a Vision-Language Model (like Qwen-VL or Gemini) to reason about the screenshot and UI Graph. It enforces strict JSON outputs for structured actions (`CLICK`, `TYPE`, `NAVIGATE`, etc.) and handles API idiosyncrasies.
- **Hallucination Guard**: Validates that the model's requested `element_id` actually exists in the provided UI Graph before passing it back to the browser.
- **Session Store**: Tracks multi-step execution history (powered by Redis, with an in-memory fallback) to prevent the agent from getting stuck in loops.

## 🚀 How to Use

### 1. Start the Backend
1. Navigate to the `backend/` directory.
2. Copy the example environment variables:
   ```bash
   cp .env.example .env
   ```
3. Update `.env` with your API provider details. 
   *(By default, we recommend setting `VLM_MODEL_NAME="openrouter/free"` or a paid vision model like `"google/gemini-2.5-flash"` on OpenRouter).*
4. Spin up the backend using Docker:
   ```bash
   docker compose up -d --build
   ```

### 2. Build & Install the Extension
1. From the root directory, install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** in the top right.
4. Click **Load unpacked** and select the `/dist` folder inside the LocalLens project.

### 3. Run a Task
1. Navigate to any webpage (e.g., a login screen).
2. Click the LocalLens extension icon in your Chrome toolbar.
3. Enter a natural language task (e.g., *"Click the login button and wait"*).
4. Hit **Start**! The agent will capture the page, plan the action via the backend, and execute it right before your eyes.

## 🔐 Privacy-Preserving Field-Cache Autofill

LocalLens includes a robust local autofill cache that prevents PII from unnecessarily leaving the device on repeat visits.

*   **How it Works**: When you fill out a form (e.g., your email address) and blur or submit the form, LocalLens derives a domain-agnostic semantic key for that field and encrypts the value into your local extension storage. When a similar field is perceived in a future session, LocalLens uses this cache hit to flag the element locally, skipping server-side processing for that data.
*   **Encrypted at Rest**: The cached values are encrypted using WebCrypto AES-GCM. The encryption key never leaves your local browser profile.
*   **Password & OTP Protection**: `PASSWORD` and `OTP` fields are **hard-excluded** and will never be cached under any circumstances.
*   **User Control**: You have full control in the extension settings (in the popup) to toggle the cache, require confirmation before filling, delete specific entries, or clear the entire cache instantly.
