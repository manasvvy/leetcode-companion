\# LeetCode Companion



An AI-powered Chrome extension that helps LeetCode users explain, defend, and reflect on their solutions while they solve problems.



\## Current Architecture



```text

LeetCode

&#x20;   │

&#x20;   ▼

Chrome Extension (Manifest V3)

&#x20;   │

&#x20;   ├── Content Script

&#x20;   │   ├── Detects Run / Submit

&#x20;   │   ├── Reads Monaco editor state

&#x20;   │   ├── Detects submission results

&#x20;   │   └── Tracks idle state

&#x20;   │

&#x20;   ├── Background Service Worker

&#x20;   │   └── Session state

&#x20;   │

&#x20;   └── chrome.storage.local

&#x20;       └── Session logs

&#x20;               │

&#x20;               ▼

&#x20;         FastAPI Backend

&#x20;               │

&#x20;               └── LLM follow-ups

Project Status

&#x20;Chrome extension scaffold

&#x20;LeetCode page detection

&#x20;Run detection

&#x20;Submit detection

&#x20;Monaco editor integration

&#x20;Accepted result detection

&#x20;Wrong Answer result detection

&#x20;Background service worker

&#x20;Session state and local storage

&#x20;Question bank and pattern detection

&#x20;FastAPI backend

&#x20;LLM-generated follow-ups

&#x20;Observability

&#x20;Learning/session dashboard

Core Idea



The extension observes how a user solves a LeetCode problem and uses meaningful moments in the solving process as learning triggers.



Examples:



Run → ask why the chosen approach works

Submit → prompt a short defense of the solution

Wrong Answer → ask which assumption may be incorrect

Accepted → generate a targeted follow-up question based on the actual solution

Idle → track the event without interrupting the user



The goal is not to provide another solution generator. The goal is to make the user explain and defend their own solution.



Tech Stack

Browser

Chrome Extension

Manifest V3

Vanilla JavaScript

Monaco editor integration

Backend

Python

FastAPI

LLM API integration

Planned Observability

Request latency

Token usage

Cost

Session metrics

Session Metrics



The extension will eventually track metrics such as:



started\_at

first\_run\_at

first\_submit\_at

explained

result

time\_to\_first\_run

time\_to\_explain



These can later be used to understand patterns such as explained vs. skipped follow-ups over time.



Development



This project is currently being developed as a public engineering project.



The browser extension is developed and tested locally as an unpacked Chrome extension.



License



MIT





Save and close Notepad.



Then run:



```powershell

git status

