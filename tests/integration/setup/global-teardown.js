/**
 * Global teardown for Playwright tests
 * Cleans up MediaSoup server and test resources
 */

export default async function globalTeardown() {
    console.log('[GlobalTeardown] Cleaning up test environment...');

    // Stop MediaSoup server if it was started
    const mediasoupServer = global.__MEDIASOUP_SERVER__;
    if (mediasoupServer && !mediasoupServer.killed) {
        console.log('[GlobalTeardown] Stopping MediaSoup server...');

        try {
            // Try graceful shutdown first
            mediasoupServer.kill('SIGTERM');

            // Wait for graceful shutdown
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    // Force kill if graceful shutdown takes too long
                    if (!mediasoupServer.killed) {
                        console.log('[GlobalTeardown] Force killing MediaSoup server...');
                        mediasoupServer.kill('SIGKILL');
                    }
                    resolve();
                }, 5000);

                mediasoupServer.on('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });

            console.log('[GlobalTeardown] MediaSoup server stopped');
        } catch (error) {
            console.warn('[GlobalTeardown] Error stopping MediaSoup server:', error);
        }
    }

    console.log('[GlobalTeardown] Cleanup complete');
}
