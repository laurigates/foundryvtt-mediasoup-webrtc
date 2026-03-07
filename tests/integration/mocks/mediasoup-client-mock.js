/**
 * Mock implementation of mediasoup-client for testing
 * Provides basic structure without the heavy WebRTC dependencies
 */

class MockDevice {
    constructor() {
        this.loaded = false;
        this._rtpCapabilities = null;
        this._sctpCapabilities = null;
    }

    async load(routerRtpCapabilities) {
        this.loaded = true;
        this._rtpCapabilities = routerRtpCapabilities;
        return Promise.resolve();
    }

    canProduce(kind) {
        return this.loaded && (kind === 'audio' || kind === 'video');
    }

    get rtpCapabilities() {
        return this._rtpCapabilities;
    }

    get sctpCapabilities() {
        return this._sctpCapabilities;
    }

    createSendTransport(options) {
        return new MockTransport('send', options);
    }

    createRecvTransport(options) {
        return new MockTransport('recv', options);
    }
}

class MockTransport {
    constructor(direction, options = {}) {
        this.direction = direction;
        this.id = options.id || `mock-transport-${Math.random().toString(36).substr(2, 9)}`;
        this.iceParameters = options.iceParameters || {};
        this.iceCandidates = options.iceCandidates || [];
        this.dtlsParameters = options.dtlsParameters || {};
        this.sctpParameters = options.sctpParameters || {};
        this.connectionState = 'new';
        this._observers = {
            connect: [],
            produce: [],
            consume: [],
            connectionstatechange: [],
        };
    }

    on(event, handler) {
        if (this._observers[event]) {
            this._observers[event].push(handler);
        }
    }

    off(event, handler) {
        if (this._observers[event]) {
            const index = this._observers[event].indexOf(handler);
            if (index > -1) {
                this._observers[event].splice(index, 1);
            }
        }
    }

    emit(event, ...args) {
        if (this._observers[event]) {
            this._observers[event].forEach((handler) => handler(...args));
        }
    }

    async connect({ dtlsParameters }) {
        this.connectionState = 'connecting';
        this.emit('connectionstatechange', 'connecting');

        // Simulate connection
        setTimeout(() => {
            this.connectionState = 'connected';
            this.emit('connectionstatechange', 'connected');
        }, 100);

        return Promise.resolve();
    }

    async produce({ kind, rtpParameters, track }) {
        if (this.direction !== 'send') {
            throw new Error('Cannot produce on recv transport');
        }

        const producer = new MockProducer({ kind, rtpParameters, track });
        this.emit('produce', producer);
        return producer;
    }

    async consume({ id, producerId, kind, rtpParameters }) {
        if (this.direction !== 'recv') {
            throw new Error('Cannot consume on send transport');
        }

        const consumer = new MockConsumer({ id, producerId, kind, rtpParameters });
        this.emit('consume', consumer);
        return consumer;
    }

    close() {
        this.connectionState = 'closed';
        this.emit('connectionstatechange', 'closed');
    }
}

class MockProducer {
    constructor({ kind, rtpParameters, track }) {
        this.id = `mock-producer-${Math.random().toString(36).substr(2, 9)}`;
        this.kind = kind;
        this.rtpParameters = rtpParameters;
        this.track = track;
        this.paused = false;
        this.closed = false;
        this._observers = {
            transportclose: [],
            trackended: [],
        };
    }

    on(event, handler) {
        if (this._observers[event]) {
            this._observers[event].push(handler);
        }
    }

    off(event, handler) {
        if (this._observers[event]) {
            const index = this._observers[event].indexOf(handler);
            if (index > -1) {
                this._observers[event].splice(index, 1);
            }
        }
    }

    emit(event, ...args) {
        if (this._observers[event]) {
            this._observers[event].forEach((handler) => handler(...args));
        }
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
    }

    close() {
        this.closed = true;
    }
}

class MockConsumer {
    constructor({ id, producerId, kind, rtpParameters }) {
        this.id = id;
        this.producerId = producerId;
        this.kind = kind;
        this.rtpParameters = rtpParameters;
        this.paused = false;
        this.closed = false;
        this.track = new MockMediaStreamTrack(kind);
        this._observers = {
            transportclose: [],
            trackended: [],
        };
    }

    on(event, handler) {
        if (this._observers[event]) {
            this._observers[event].push(handler);
        }
    }

    off(event, handler) {
        if (this._observers[event]) {
            const index = this._observers[event].indexOf(handler);
            if (index > -1) {
                this._observers[event].splice(index, 1);
            }
        }
    }

    emit(event, ...args) {
        if (this._observers[event]) {
            this._observers[event].forEach((handler) => handler(...args));
        }
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
    }

    close() {
        this.closed = true;
    }
}

class MockMediaStreamTrack {
    constructor(kind) {
        this.kind = kind;
        this.id = `mock-track-${Math.random().toString(36).substr(2, 9)}`;
        this.label = `Mock ${kind} track`;
        this.enabled = true;
        this.muted = false;
        this.readyState = 'live';
    }

    clone() {
        return new MockMediaStreamTrack(this.kind);
    }

    stop() {
        this.readyState = 'ended';
    }
}

// Mock detectDevice function
function detectDevice() {
    return {
        flag: 'chrome',
        name: 'Chrome',
        version: '120.0.0',
    };
}

// Create mock mediasoup-client object
const mockMediasoupClient = {
    version: '3.11.0',
    Device: MockDevice,
    detectDevice: detectDevice,

    // Additional exports that might be used
    types: {
        RtpCodecCapability: {},
        RtpHeaderExtension: {},
        RtpParameters: {},
        RtpCapabilities: {},
        SctpCapabilities: {},
    },

    // Mock some utility functions
    parseScalabilityMode: (_scalabilityMode) => ({
        spatialLayers: 1,
        temporalLayers: 1,
    }),

    getSupportedRtpCapabilities: () => ({
        codecs: [
            {
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2,
            },
            {
                mimeType: 'video/VP8',
                clockRate: 90000,
            },
        ],
        headerExtensions: [],
    }),
};

// Export for ES modules
export default mockMediasoupClient;

// Also set on window for global access
if (typeof window !== 'undefined') {
    window.mediasoupClient = mockMediasoupClient;
}
