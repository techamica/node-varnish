import path from "path"

// Helper function to get cache path
function getCacheFilePath(cacheDir, req) {
    const encodedUrl = encodeURIComponent(req.url)

    return {
        file: path.join(cacheDir, encodedUrl),
        meta: path.join(cacheDir, `${encodedUrl}.meta`) // Metadata file for timestamp
    }
}

export { getCacheFilePath }