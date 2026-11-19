const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

/**
 * Authentication Middleware:
 * Verifies Bearer session token against SQLite users table.
 * Server-side session verification ensures only authenticated users with valid active sessions proceed.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Session token required' });
  }

  const user = db.prepare('SELECT id, name, email, role, session_token FROM users WHERE session_token = ?').get(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }

  req.user = user;
  next();
}

/**
 * Role-Based Access Control Middleware Helper:
 * Validates role server-side so client privileges cannot be forged or tampered with.
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Forbidden: requires ${role} role` });
    }
    next();
  };
}

/**
 * POST /api/auth/login
 * Security / Anti-cheating features:
 * 1. Password verified against bcrypt hash.
 * 2. Single active session: generating a new session_token overwrites any prior token in the database,
 *    instantly invalidating concurrent sessions from other browsers or devices.
 */
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const isMatch = bcrypt.compareSync(password, user.password_hash);
  if (!isMatch) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Generate new random UUID session token
  const sessionToken = uuidv4();

  // Store new session token to invalidate any previous active session
  db.prepare('UPDATE users SET session_token = ? WHERE id = ?').run(sessionToken, user.id);

  return res.json({
    token: sessionToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    }
  });
});

module.exports = {
  router,
  authenticateToken,
  requireRole
};
