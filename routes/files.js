const express = require("express");
const router = express.Router();
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Store covers directly on Cloudinary
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "gamevault/covers",
    allowed_formats: ["jpg", "jpeg", "png", "gif", "webp"],
    transformation: [{ width: 460, height: 215, crop: "fill" }],
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// POST /api/files/upload
router.post("/upload", authMiddleware, upload.single("cover"), async (req, res) => {
  const { title, description, game, category, download_url } = req.body;
  if (!title || !game) return res.status(400).json({ error: "Title and game are required." });
  if (!download_url) return res.status(400).json({ error: "A download link is required." });
  try { new URL(download_url); } catch {
    return res.status(400).json({ error: "Please enter a valid URL." });
  }

  // Cloudinary gives us a secure URL directly
  const coverUrl = req.file ? req.file.path : null;

  try {
    const result = await pool.query(
      `INSERT INTO files (id, title, description, game, category, download_url, cover_image, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [uuidv4(), title, description || "", game, category || "Other",
       download_url, coverUrl, req.user.id]
    );
    const newFile = result.rows[0];
    const io = req.app.get("io");
    io.emit("activity:new", {
      type: "upload", username: req.user.username,
      title, game, fileId: newFile.id, timestamp: new Date().toISOString(),
    });
    res.status(201).json({ message: "File listed successfully.", file: newFile });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ error: "Server error during upload." });
  }
});

// GET /api/files
router.get("/", async (req, res) => {
  const { search, game, category } = req.query;
  let query = `
    SELECT f.*, u.username AS uploader_name,
      COALESCE(AVG(r.rating), 0) AS avg_rating,
      COUNT(DISTINCT r.id) AS rating_count,
      COUNT(DISTINCT c.id) AS comment_count
    FROM files f
    JOIN users u ON f.uploaded_by = u.id
    LEFT JOIN ratings r ON r.file_id = f.id
    LEFT JOIN comments c ON c.file_id = f.id
    WHERE 1=1
  `;
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    query += ` AND (f.title ILIKE $${params.length} OR f.game ILIKE $${params.length})`;
  }
  if (game) { params.push(game); query += ` AND f.game = $${params.length}`; }
  if (category) { params.push(category); query += ` AND f.category = $${params.length}`; }
  query += " GROUP BY f.id, u.username ORDER BY f.created_at DESC";
  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/files/:id
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*, u.username AS uploader_name,
        COALESCE(AVG(r.rating), 0) AS avg_rating,
        COUNT(DISTINCT r.id) AS rating_count,
        COUNT(DISTINCT c.id) AS comment_count
       FROM files f JOIN users u ON f.uploaded_by = u.id
       LEFT JOIN ratings r ON r.file_id = f.id
       LEFT JOIN comments c ON c.file_id = f.id
       WHERE f.id = $1 GROUP BY f.id, u.username`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "File not found." });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/files/:id/click
router.post("/:id/click", async (req, res) => {
  try {
    await pool.query("UPDATE files SET downloads = downloads + 1 WHERE id = $1", [req.params.id]);
    const result = await pool.query("SELECT downloads FROM files WHERE id = $1", [req.params.id]);
    const io = req.app.get("io");
    io.emit("download:count", { fileId: req.params.id, downloads: result.rows[0].downloads });
    res.json({ downloads: result.rows[0].downloads });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/files/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM files WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "File not found." });
    const file = result.rows[0];
    if (file.uploaded_by !== req.user.id) return res.status(403).json({ error: "Not authorized." });
    // Delete from Cloudinary if cover exists
    if (file.cover_image && file.cover_image.includes("cloudinary")) {
      const publicId = file.cover_image.split("/").slice(-1)[0].split(".")[0];
      await cloudinary.uploader.destroy(`gamevault/covers/${publicId}`);
    }
    await pool.query("DELETE FROM files WHERE id = $1", [req.params.id]);
    res.json({ message: "File deleted." });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/files/:id/rate
router.post("/:id/rate", authMiddleware, async (req, res) => {
  const { rating } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be 1-5." });
  try {
    await pool.query(
      `INSERT INTO ratings (id, file_id, user_id, rating) VALUES ($1,$2,$3,$4)
       ON CONFLICT (file_id, user_id) DO UPDATE SET rating = $4`,
      [uuidv4(), req.params.id, req.user.id, rating]
    );
    const result = await pool.query(
      "SELECT COALESCE(AVG(rating),0) AS avg_rating, COUNT(*) AS rating_count FROM ratings WHERE file_id=$1",
      [req.params.id]
    );
    const io = req.app.get("io");
    io.emit("rating:update", { fileId: req.params.id, ...result.rows[0] });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/files/:id/rating
router.get("/:id/rating", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT rating FROM ratings WHERE file_id=$1 AND user_id=$2",
      [req.params.id, req.user.id]
    );
    res.json({ rating: result.rows[0]?.rating || 0 });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/files/:id/comments
router.get("/:id/comments", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.username FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.file_id=$1 ORDER BY c.created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/files/:id/comments
router.post("/:id/comments", authMiddleware, async (req, res) => {
  const { content } = req.body;
  if (!content || content.trim() === "") return res.status(400).json({ error: "Comment cannot be empty." });
  try {
    const result = await pool.query(
      `INSERT INTO comments (id, file_id, user_id, content) VALUES ($1,$2,$3,$4) RETURNING *`,
      [uuidv4(), req.params.id, req.user.id, content.trim()]
    );
    const comment = result.rows[0];
    const userResult = await pool.query("SELECT username FROM users WHERE id=$1", [req.user.id]);
    const fullComment = { ...comment, username: userResult.rows[0].username };
    const io = req.app.get("io");
    io.emit("comment:new", { fileId: req.params.id, comment: fullComment });
    res.status(201).json(fullComment);
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/files/:id/comments/:commentId
router.delete("/:id/comments/:commentId", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM comments WHERE id=$1", [req.params.commentId]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Comment not found." });
    if (result.rows[0].user_id !== req.user.id) return res.status(403).json({ error: "Not authorized." });
    await pool.query("DELETE FROM comments WHERE id=$1", [req.params.commentId]);
    res.json({ message: "Comment deleted." });
  } catch (err) {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
