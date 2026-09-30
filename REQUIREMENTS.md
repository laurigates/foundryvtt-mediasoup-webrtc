# **FoundryVTT MediaSoup A/V Plugin \- Requirements Specification**

**Version:** 0.2 **Date:** September 30, 2026 (0.1: May 22, 2025) **Project Goal:** To create a FoundryVTT module that provides audio and video communication for players using a self-hosted MediaSoup server, replacing existing A/V solutions and enabling server-side audio recording for external processing.

## **1\. Introduction**

### **1.1. Purpose**

This document outlines the functional and non-functional requirements for the **MediaSoupVTT** plugin. This plugin will integrate with Foundry Virtual Tabletop (FoundryVTT) and a self-hosted MediaSoup server to provide real-time audio and video communication between users in a game session. A key driver for this plugin is to facilitate server-side recording of audio streams, which can then be used by an external D\&D helper application for transcription and summarization.

### **1.2. Scope**

The plugin will handle:

* Client-side capture from the microphone and webcam chosen in Foundry's core A/V settings.  
* Signaling and media stream management with a MediaSoup server.  
* Display of local and remote video feeds within the FoundryVTT interface.  
* Playback of remote audio streams.  
* Basic user controls for A/V functions.  
* Configuration settings for connecting to the self-hosted MediaSoup server.

The MediaSoup server itself and the external D\&D helper application are outside the scope of this document but are key components of the overall system.

### **1.3. Definitions, Acronyms, and Abbreviations**

* **FoundryVTT:** Foundry Virtual Tabletop, the application this plugin is for.  
* **MediaSoup:** An open-source WebRTC Selective Forwarding Unit (SFU) library.  
* **SFU:** Selective Forwarding Unit.  
* **WebRTC:** Web Real-Time Communication.  
* **A/V:** Audio/Video.  
* **UI:** User Interface.  
* **UX:** User Experience.  
* **GM:** Game Master.  
* **API:** Application Programming Interface.

## **2\. General Description**

### **2.1. Product Perspective**

The MediaSoupVTT plugin will be a user-installable module for FoundryVTT. It will act as a client to a separately maintained, self-hosted MediaSoup server. It aims to replace other A/V solutions like the avclient-livekit module, offering more direct control over the A/V pipeline, particularly for audio stream extraction on the server side.

### **2.2. Product Functions (High-Level)**

* **FNC-001:** Establish and manage A/V connections between players via MediaSoup.  
* **FNC-002:** Capture local audio and video from users.  
* **FNC-003:** Transmit local A/V streams to the MediaSoup server.  
* **FNC-004:** Receive remote A/V streams from the MediaSoup server.  
* **FNC-005:** Display remote video feeds and play remote audio.  
* **FNC-006:** Provide user controls for local A/V (mute/unmute, camera on/off).  
* **FNC-007:** Allow configuration of the MediaSoup server connection.  
* **FNC-008:** Enable server-side recording by reliably delivering audio streams to the MediaSoup server (the recording itself is a server function).

### **2.3. User Characteristics**

* **FoundryVTT Users:** Players and GMs familiar with using FoundryVTT.  
* **Plugin Administrator (likely the GM or server host):** Users capable of setting up and configuring a self-hosted MediaSoup server and configuring the plugin to connect to it.

### **2.4. Assumptions and Dependencies**

* **DEP-001:** Users will have access to a running and correctly configured MediaSoup server.  
* **DEP-002:** The MediaSoup server will implement the signaling protocol expected by this plugin.  
* **DEP-003:** Users have granted necessary browser permissions for microphone and camera access.  
* **DEP-004:** The mediasoup-client JavaScript library will be used for client-side MediaSoup interactions.  
* **ASM-001:** The primary use case for server-side audio capture is for a D\&D helper application.

## **3\. Functional Requirements ⚙️**

### **3.1. Connection Management**

* **FR-CON-001:** The plugin **shall** allow users to configure the WebSocket URL of their MediaSoup server.  
* **FR-CON-002:** The plugin **shall** connect to the configured MediaSoup server when Foundry's A/V conference is enabled (core AVMaster starts and stops the connection).  
* **FR-CON-003:** *(Withdrawn in 0.2.)* A separate auto-connect option is not needed: core connects whenever the conference mode in Configure Audio/Video is not Disabled.  
* **FR-CON-004:** The plugin **shall** communicate with the MediaSoup server using a defined WebSocket-based signaling protocol.  
  * This includes joining a room (tied to the FoundryVTT game session/world).  
  * Loading router RTP capabilities.  
  * Creating and connecting WebRTC transports (send and receive).  
* **FR-CON-005:** The plugin **shall** indicate the current connection status to the MediaSoup server (e.g., disconnected, connecting, connected, error).  
* **FR-CON-006:** The plugin **shall** gracefully handle disconnections and provide a way to reconnect.

### **3.2. Local Media Management (Client-Side)**

* **FR-LMM-001:** The plugin **shall** request permission to access the user's microphone and webcam.  
* **FR-LMM-002:** The plugin **shall** use the audio input (microphone) and video input (webcam) devices the user selects in Foundry's Configure Audio/Video, and follow changes to them.  
* **FR-LMM-003:** The plugin **shall** capture audio from the selected microphone.  
* **FR-LMM-004:** The plugin **shall** capture video from the selected webcam.  
* **FR-LMM-005:** The plugin **shall** create MediaSoup producers for the local audio and video tracks and send them via the send transport.  
* **FR-LMM-006:** The plugin **shall** honour Foundry's core A/V controls (camera dock, AVSettings) for the user to:  
  * Mute/unmute their local microphone.  
  * Turn their local camera on/off.  
* **FR-LMM-007 (Optional):** The plugin **may** provide a local preview of the user's webcam feed.

### **3.3. Remote Media Management (Client-Side)**

* **FR-RMM-001:** The plugin **shall** be notified by the MediaSoup server about new remote participants and their available media streams (producers).  
* **FR-RMM-002:** The plugin **shall** create MediaSoup consumers for available remote audio and video tracks via the receive transport.  
* **FR-RMM-003:** The plugin **shall** play received remote audio tracks.  
* **FR-RMM-004:** The plugin **shall** display received remote video tracks in Foundry's core camera dock (CameraViews).  
* **FR-RMM-005:** The plugin **shall** handle remote users joining and leaving the A/V session, adding/removing their media elements accordingly.  
* **FR-RMM-006:** The plugin **shall** handle remote users muting/unmuting audio or turning video on/off (e.g., by stopping/starting video display, or server indicating producer pause/resume).  
* **FR-RMM-007 (Optional):** The plugin **may** allow users to adjust the volume of individual remote audio streams.

### **3.4. User Interface (UI) & User Experience (UX)**

* **FR-UIX-001:** A/V controls (mute, video on/off, settings) **shall** be the ones Foundry core provides (camera dock and Configure Audio/Video); the plugin adds no separate control bar.  
* **FR-UIX-002:** Video feeds **shall** be displayed in Foundry's core camera dock.  
* **FR-UIX-003:** The plugin **shall** provide visual feedback for:  
  * Local mute/video status.  
  * Remote user mute/video status (if provided by server signaling).  
  * Speaking indicators for active remote users.  
  * Connection status.  
* **FR-UIX-004:** Error messages **shall** be user-friendly and provide guidance where possible.

### **3.5. Configuration**

* **FR-CFG-001:** The plugin **shall** provide a settings menu within FoundryVTT for configuration.  
* **FR-CFG-002:** Required settings **shall** include:  
  * MediaSoup Server WebSocket URL.  
  * MediaSoup server auth token (the server's shared secret; blank when the server runs without one).  
* **FR-CFG-003 (Optional):** Optional settings **may** include:  
  * Debug logging.  
  * Video quality preferences (if supported by the client-server interaction).  
* **FR-CFG-004:** Devices, mute state, voice mode and push-to-talk **shall not** be module settings; they belong to Foundry's core AVSettings.

## **4\. Non-Functional Requirements 🌟**

### **4.1. Performance**

* **NFR-PRF-001:** The plugin **should** minimize its impact on FoundryVTT client-side performance (CPU, memory).  
* **NFR-PRF-002:** Audio latency **should** be low enough to facilitate natural conversation.  
* **NFR-PRF-003:** Video streaming **should** be reasonably smooth, adapting to available bandwidth where possible (MediaSoup server handles much of this, but client producing matters).

### **4.2. Reliability**

* **NFR-REL-001:** The plugin **should** maintain stable connections to the MediaSoup server under normal network conditions.  
* **NFR-REL-002:** The plugin **should** gracefully handle temporary network interruptions and attempt to reconnect if feasible.  
* **NFR-REL-003:** The plugin **should** correctly manage resources (e.g., release camera/microphone when not in use or when disconnecting).

### **4.3. Usability**

* **NFR-USB-001:** The plugin **shall** be easy to install and configure for users familiar with FoundryVTT modules.  
* **NFR-USB-002:** Basic A/V operations (mute, camera toggle) **shall** be intuitive.

### **4.4. Compatibility**

* **NFR-CMP-001:** The plugin **shall** be compatible with the minimum and verified FoundryVTT versions in `module.json` (minimum v13; v14 is the target, and `verified` is raised only after the Foundry e2e suite passes on that build).  
* **NFR-CMP-002:** The plugin **shall** function correctly in modern web browsers that support WebRTC and are supported by FoundryVTT (primarily Chromium-based due to Electron).

### **4.5. Maintainability**

* **NFR-MNT-001:** The plugin's code **should** be well-structured, commented, and organized to facilitate future updates and bug fixes.  
* **NFR-MNT-002:** The signaling protocol between the plugin and the MediaSoup server **shall** be clearly defined to allow independent development/updates if necessary.

### **4.6. Security**

* **NFR-SEC-001:** All communication with the MediaSoup server (signaling and media) **should** use secure protocols (WSS for WebSockets, DTLS-SRTP for media). This is primarily configured on the MediaSoup server but the client must connect appropriately.  
* **NFR-SEC-002:** The plugin **shall not** store sensitive user information beyond what is necessary for its operation within the session and FoundryVTT's existing data structures.

## **5\. Interface Requirements**

### **5.1. User Interface**

* Refer to **Section 3.4 (User Interface & User Experience)**.  
* The UI should integrate smoothly with the existing FoundryVTT aesthetic.

### **5.2. Software Interfaces**

* **FoundryVTT API:** The plugin will use FoundryVTT's JavaScript API for hooks, settings, UI integration, and accessing user/game data. It integrates as an AVClient (`foundry.av.AVClient`, registered as `CONFIG.WebRTC.clientClass`), and its dialogs are ApplicationV2.  
* **MediaSoup Server API:** The plugin will communicate with the custom MediaSoup server via a WebSocket-based signaling API. The specifics of this API (message formats, request/response types) must be strictly defined and implemented by both the client plugin and the server.  
* **mediasoup-client Library API:** The plugin will use the mediasoup-client JavaScript library for all client-side WebRTC and MediaSoup-specific interactions (Device, Transports, Producers, Consumers).  
* **WebRTC API (Browser):** The plugin will use browser WebRTC APIs (e.g., navigator.mediaDevices.getUserMedia, RTCPeerConnection \- though mostly abstracted by mediasoup-client).

## **6\. Server-Side Considerations (Informative)**

While the MediaSoup server is outside the scope of this client plugin's requirements, the plugin's design depends on the server providing:

* A WebSocket endpoint for signaling.  
* Implementation of the agreed-upon signaling protocol.  
* Functionality to create and manage MediaSoup rooms, workers, routers, and transports.  
* Capability to receive RTP streams from clients.  
* **The critical capability to record incoming audio RTP streams (e.g., by piping them to FFmpeg or GStreamer) and save them as audio files accessible by the external D\&D helper application.** (Not implemented in `server/` yet.)