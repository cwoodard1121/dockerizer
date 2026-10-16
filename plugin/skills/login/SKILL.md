---
name: login
description: Walk Cameron through signing dockeriser in to Google Cloud (gcloud install, gcloud login, project setup, credentials) one step at a time. Use when dockeriser says it is not signed in, when a dockeriser build exits with code 2 or 3, or when asked to set up or log in to dockeriser or Cloud Build.
---

# dockeriser login

The CLI path is in the session-start note; if there is none use
`C:/Users/camer/Desktop/Projects/dockeriser/bin/dockeriser.js` (called `CLI` below).

1. Run `node CLI login`. It never opens a browser or asks questions; it prints only the next step(s).
2. If it prints "Signed in as …", relay that line and the usage line. Done.
3. Otherwise show Cameron only the FIRST step, with its command in a code block, in plain words.
   - Commands that open a browser (`gcloud auth login`, `gcloud auth application-default login …`)
     must be run by Cameron. Tell him to type them in the Claude prompt with a leading `!`, for example
     `! gcloud auth login`. You cannot complete a browser sign-in for him.
   - `winget install Google.CloudSDK` and the `setup.ps1` script you may run for him if he asks, but the
     setup script needs his project ID (and billing linked to the project). Ask for the ID if you do not have it.
4. After he says a step is done, run `node CLI login` again and repeat until it says "Signed in as …".
