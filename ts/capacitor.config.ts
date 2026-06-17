import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for the iOS / Android mobile wrapper.
 *
 * The bundle ID (app.aloud.meditation) and app name carry the final
 * "aloud" branding (rebrand done in 1.0). They're the visible identity
 * in the App Store / Play Store, and once set on a published app they're
 * effectively permanent — don't change them. `npx cap add ios/android`
 * bakes them into the generated native projects.
 */
const config: CapacitorConfig = {
    appId: 'app.aloud.meditation',
    appName: 'aloud',
    webDir: 'ui/dist',

    // Live reload during development.
    // Uncomment + set to your Vite dev server URL (or run via
    // `npx cap run ios --livereload --external` which Capacitor will
    // wire up automatically when --livereload is passed).
    //
    // server: {
    //     url: 'http://192.168.1.x:5173',
    //     cleartext: true,
    // },

    ios: {
        // Allow http://localhost requests during dev. Production builds
        // should talk to your real backend over https.
        limitsNavigationsToAppBoundDomains: false,
    },

    android: {
        // Mirror iOS — relaxed network policy for dev builds.
        allowMixedContent: true,
    },

    plugins: {
        // @capacitor-community/speech-recognition needs explicit usage
        // strings on iOS. These show up in the system permission prompt
        // the first time the user enables the mic.
        SpeechRecognition: {
            // Empty for now — gets surfaced in iOS Info.plist after
            // `cap add ios` runs. Customize for the rebrand.
        },
    },
};

export default config;
