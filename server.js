// Import Node.JS modules
import express from "express"
import httpProxy from "http-proxy"
import rateLimit from "express-rate-limit"
import requestIp from "request-ip"
import cluster from "cluster"
import os from "os"
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import fs from "fs"
import path from "path"
import { rimrafSync } from "rimraf"

// Import custom modules
import config from "./manifest.js"
import { getCacheFilePath } from "./helper.js"
import proxy_list from "./proxy.js"

/**
 * S T A R T: MAKE NECESSARY PREPARATIONS TO RUN THE SERVER
 */
// Get the current file's URL and convert it to a path
const __filename = fileURLToPath(import.meta.url)
// Get the directory name from the file path
const __dirname = dirname(__filename)

const cacheDuration = config.CACHE_DURATION

// Set cache directory
const cacheDir = path.join(__dirname, config.CACHE_DIR)
// Delete cache directory if the server started in PRODUCTION mode
if (config.MODE === "PRODUCTION") {
    try {
        if (fs.existsSync(cacheDir))
            rimrafSync(cacheDir)
    } catch (err) { }
}
// If cache directory doesn't exist, create one
if (!fs.existsSync(cacheDir)) {
    try {
        fs.mkdirSync(cacheDir)
    } catch (err) { }
}
/**
 * E N D: MAKE NECESSARY PREPARATIONS TO RUN THE SERVER
 */

// Check if the current process is a master
if (cluster.isMaster) {
    const numCPUs = os.cpus().length > config.MAXIMUM_CORE_TO_USE ? config.MAXIMUM_CORE_TO_USE : os.cpus().length // Get the number of CPU cores

    // Fork workers
    for (let i = 0; i < numCPUs; i++) {
        const worker = cluster.fork()
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died`)

        // start a new virtual node
        cluster.fork()
    })
}
else {
    const app = express()
    const proxy = httpProxy.createProxyServer({})

    // Middleware to capture client IP
    app.use(requestIp.mw())

    app.use((req, res, next) => {
        const clientIp = req.clientIp // This will give you the correct client IP
        // console.log('Client IP:', clientIp)
        next()
    })

    /**
     * S T A R T: DEFINE THE CACHING MECHANISM FOR PRODUCTION MODE
     */
    if (config.MODE === "PRODUCTION") {
        // Middleware to serve cache files
        app.use((req, res, next) => {
            const ext = req.url.split('.').pop()
            const isCacheable = ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'webp', "woff2", "woff", "ttf"].includes(ext)

            if (isCacheable) {
                // Set Cache-Control headers for browser caching
                res.setHeader('Cache-Control', `public, max-age=${Math.ceil(config.CACHE_DURATION / 1000)}`)

                try {
                    const { file: cacheFile, meta } = getCacheFilePath(cacheDir, req)

                    if (fs.existsSync(cacheFile) && fs.existsSync(meta)) {
                        const cachedTime = fs.readFileSync(meta, 'utf-8')
                        const now = Date.now()

                        // If the file is still valid (less than cacheDuration old), serve it
                        if (now - cachedTime < cacheDuration) {
                            // console.log('Serving from cache:', req.url)

                            // Serve cached file as a stream
                            res.setHeader('X-Cache', 'HIT')
                            const readStream = fs.createReadStream(cacheFile)
                            readStream.pipe(res) // Stream the cached file to the client
                            return
                        }

                        // Otherwise, remove expired files
                        fs.unlinkSync(cacheFile)
                        fs.unlinkSync(meta)
                    }

                    // If not in cache, continue to proxy and cache response later
                    res.setHeader('X-Cache', 'MISS')
                } catch (err) { }
            }

            next()
        })

        // Proxy response event to cache the static files
        proxy.on('proxyRes', (proxyRes, req, res) => {
            // console.log(`${config.MODE}: ${req.url}`)

            const ext = req.url.split('.').pop()
            const isCacheable = ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'webp', "woff2", "woff", "ttf"].includes(ext)

            if (isCacheable) {
                try {
                    const { file: cacheFile, meta } = getCacheFilePath(cacheDir, req)

                    // console.log("saving", req.url)

                    // Create a write stream to save the response to cache
                    // const writeStream = fs.createWriteStream(cacheFile)

                    // Save the current timestamp to the metadata file
                    // fs.writeFileSync(meta, Date.now().toString())

                    // Pipe the response from the proxy server to the cache
                    // proxyRes.pipe(writeStream)

                    // Set Cache-Control headers for browser caching
                    res.setHeader('Cache-Control', `public, max-age=${Math.ceil(config.CACHE_DURATION / 1000)}`)

                    // Ensure the response doesn't finish prematurely
                    // res.writeHead = () => { }
                } catch (err) {
                    console.log(err)
                }
            }
        })
    }
    /**
     * E N D: DEFINE THE CACHING MECHANISM FOR PRODUCTION MODE
     */

    // Add a middleware to prevent caching of HTML documents
    app.use((req, res, next) => {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate")
        res.setHeader("Pragma", "no-cache")
        res.setHeader("Expires", "0")
        next()
    })

    /**
     * S T A R T: DEFINE THE RATE LIMITER
     */
    // Define rate limiting middleware
    const limiter = rateLimit({
        windowMs: config.MAXIMUM_HIT_TIMEOUT,
        max: config.MAXIMUM_HIT_LIMIT,
        // message: 'Too many requests from this IP, please try again later.',
        handler: (req, res, next) => {
            // console.log("Request URL before proxy:", req.url);
            // if (req.url.includes("retry-later"))
            // req.url = req.url.split("retry-later").join("")

            res.status(429) // Set status to 429 (Too Many Requests)
            req.url = "/retry-later"; // Override the URL path
            return proxy.web(req, res, {
                target: "http://localhost:3000",
                selfHandleResponse: false, // Ensures proxy handles the response itself
            })
        },
        keyGenerator: (req) => `ip_${req.clientIp}`, // Use the IP address as the key
    })

    // Apply the rate limiting middleware to all requests
    app.use(limiter)
    /**
     * E N D: DEFINE THE RATE LIMITER
     */

    // Handle the reverse proxy
    app.use((req, res) => {
        try {
            let found_proxy = false

            // console.log(req.url)

            proxy_list.forEach(element => {
                if (!found_proxy) {
                    // console.log(element.prefix)

                    if (element.prefix.filter(v => req.url.startsWith(v)).length > 0) {
                        found_proxy = true

                        res.status(200)
                        proxy.web(req, res, { target: `${element.protocol}://${element.host}${element.port === 80 || element.port === 443 ? "" : `:${element.port}`}`, changeOrigin: false }, (err) => {
                            if (err) {
                                res.writeHead(503, { 'Content-Type': 'text/plain' })
                                return res.end('Backend Fetch Error')
                            }
                        })
                    }
                }
            })

            if (found_proxy)
                return

            // Redirection for rest to the INDEX server
            res.status(200)
            proxy.web(req, res, { target: "http://localhost:3000/", changeOrigin: false }, (err) => {
                if (err) {
                    res.writeHead(503, { 'Content-Type': 'text/plain' })
                    return res.end('Backend Fetch Error')
                }
            })
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            return res.end('Server Error')
        }
    })

    // Start the server
    app.listen(config.PORT, () => {
        console.log(`Reverse proxy with rate limiting listening on port ${config.PORT}`)
    })
}