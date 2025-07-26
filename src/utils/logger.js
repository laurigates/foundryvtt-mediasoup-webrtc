/**
 * Logging utilities for MediaSoupVTT
 */

import { MODULE_ID, LOG_PREFIX, SETTING_DEBUG_LOGGING } from '../constants/index.js';

export function log(message, level = 'info', force = false) {
    // Safe setting access - fallback to false if setting not yet registered
    let settingDebug = false;
    try {
        settingDebug = game.settings.get(MODULE_ID, SETTING_DEBUG_LOGGING);
    } catch (_error) {
        // Setting not yet registered, use default
        settingDebug = false;
    }
    if (level === 'debug' && !settingDebug && !force) return;
    
    const timestamp = new Date().toLocaleTimeString();
    const enrichedMessage = `[${timestamp}] ${message}`;
    
    switch (level) {
    case 'warn': 
        console.warn(`${LOG_PREFIX} ${enrichedMessage}`); 
        break;
    case 'error': 
        console.error(`${LOG_PREFIX} ${enrichedMessage}`); 
        break;
    case 'info': 
        console.info(`${LOG_PREFIX} ${enrichedMessage}`); 
        break;
    case 'debug': 
        console.debug(`${LOG_PREFIX} ${enrichedMessage}`); 
        break;
    default: 
        console.log(`${LOG_PREFIX} ${enrichedMessage}`);
    }
}