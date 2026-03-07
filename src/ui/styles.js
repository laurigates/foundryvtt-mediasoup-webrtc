/**
 * CSS styles for MediaSoupVTT UI elements
 */

export function injectStyles() {
    const styles = `
        .mediasoup-video-container {
            max-width: 160px;
            max-height: 120px;
            margin-top: 5px;
            overflow: hidden;
            border-radius: 4px;
            background-color: #111;
        }
        .mediasoup-remote-video, .mediasoup-video-preview {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
        }
        .mediasoup-video-preview {
            position: fixed;
            bottom: 70px;
            right: 20px;
            width: 200px; 
            height: 150px;
            border: 2px solid #555;
            background-color: black;
            z-index: 1050;
            box-shadow: 0 0 10px rgba(0,0,0,0.5);
        }
        #player-list .player .player-name {
            position: relative;
            z-index: 1;
        }
    `;
    const existingStyles = document.getElementById('mediasoup-vtt-styles');
    if (existingStyles) {
        existingStyles.remove();
    }

    const styleElement = document.createElement('style');
    styleElement.id = 'mediasoup-vtt-styles';
    styleElement.textContent = styles;
    document.head.appendChild(styleElement);
}
