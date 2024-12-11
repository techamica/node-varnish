const config = {
    MODE: "PRODUCTION",

    PORT: 80,

    CACHE_DURATION: 1000 * 60 * 60 * 24,    // 24 hours
    CACHE_DIR: "cache",

    MAXIMUM_HIT_LIMIT: 100,
    MAXIMUM_HIT_TIMEOUT: 1000 * 60,     // 60 seconds

    MAXIMUM_CORE_TO_USE: 6,
}

export default config