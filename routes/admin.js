const express = require("express");
const router = express.Router();
const pool = require("../db");
const authMiddleware = require("../middleware/authMiddleware");
const fs = require("fs");
const path = require("path");

// Middleware to check admin
const adminMiddleware = async (req, res, next) => {
  try {
    const result = await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.user.id]);
    if (!result.rows[0]?.is_admin) return res.status(403).json({ error: "Admin access required." });
    next();
  } catch {
    res.status(500).json({ error: "Server error." });
  }
};

// GET /api/admin/stats
router.get("/stats", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await pool.query("SELECT COUNT(*) FROM users");
    const files = await pool.query("SELECT COUNT(*) FROM files");
    const downloads = await pool.query("SELECT COALESCE(SUM(downloads),0) AS total FROM files");
    const comments = await pool.query("SELECT COUNT(*) FROM comments");
    res.json({
      users: users.rows[0].count,
      files: files.rows[0].count,
      downloads: downloads.rows[0].total,
      comments: comments.rows[0].count,
    });
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/admin/users
router.get("/users", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.is_admin, u.created_at,
        COUNT(f.id) AS file_count
       FROM users u
       LEFT JOIN files f ON f.uploaded_by = u.id
       GROUP BY u.id ORDER BY u.created_at DESC`
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

// GET /api/admin/files
router.get("/files", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*, u.username AS uploader_name,
        COALESCE(AVG(r.rating),0) AS avg_rating,
        COUNT(DISTINCT c.id) AS comment_count
       FROM files f
       JOIN users u ON f.uploaded_by = u.id
       LEFT JOIN ratings r ON r.file_id = f.id
       LEFT JOIN comments c ON c.file_id = f.id
       GROUP BY f.id, u.username
       ORDER BY f.created_at DESC`
    );
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/admin/files/:id
router.delete("/files/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM files WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "File not found." });
    const file = result.rows[0];
    const uploadDir = path.join(__dirname, "../uploads");
    const coversDir = path.join(__dirname, "../uploads/covers");
    const filePath = path.join(uploadDir, file.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (file.cover_image) {
      const coverPath = path.join(coversDir, file.cover_image);
      if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
    }
    await pool.query("DELETE FROM files WHERE id = $1", [req.params.id]);
    res.json({ message: "File deleted by admin." });
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/admin/users/:id
router.delete("/users/:id", authMiddleware, adminMiddleware, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "Cannot delete yourself." });
  try {
    await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.json({ message: "User deleted." });
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

// PATCH /api/admin/users/:id/toggle-admin
router.patch("/users/:id/toggle-admin", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE users SET is_admin = NOT is_admin WHERE id = $1 RETURNING is_admin",
      [req.params.id]
    );
    res.json({ is_admin: result.rows[0].is_admin });
  } catch {
    res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
module.exports.adminMiddleware = adminMiddleware;
