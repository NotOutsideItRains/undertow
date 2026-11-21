// How Undertow introduces itself to services it calls: the app and its version, where it lives, and what it runs on.
export const UA = `Undertow/${process.env.APP_VERSION || "1.5"} (+${process.env.PUBLIC_URL || "https://quiet-otter.outsideitrains.com/"}; Node.js/${process.versions.node})`;
