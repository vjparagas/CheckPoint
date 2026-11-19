const express = require('express');
const path = require('path');
require('./db'); // Initialize and seed database schema on startup
const { router: authRouter } = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse incoming JSON request bodies
app.use(express.json());

// Serve static frontend assets from /public directory
app.use(express.static(path.join(__dirname, 'public')));

// Mount authentication routes
app.use('/api/auth', authRouter);

// Start server when run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`CheckPoint server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
