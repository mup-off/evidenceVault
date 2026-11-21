'use strict';

const express = require('express');

const { pool } = require('./db');
const { HttpError, asyncHandler, errorHandler } = require('./errors');
const { authenticate } = require('./middleware/auth');
const alertRoutes = require('./routes/alerts');
const auditRoutes = require('./routes/audit');
const authRoutes = require('./routes/auth');
const caseRoutes = require('./routes/cases');
const dashboardRoutes = require('./routes/dashboard');
const evidenceRoutes = require('./routes/evidence');
const transferRoutes = require('./routes/transfers');
const userRoutes = require('./routes/users');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // A friendly landing response for anyone opening the API in a browser.
  app.get('/api', (req, res) => {
    res.json({
      name: 'EvidenceVault Rwanda API',
      status: 'running',
      health: '/api/health',
      signIn: 'POST /api/auth/login with { email, password }',
      note: 'Other endpoints need an Authorization: Bearer <token> header; see backend/README.md.',
    });
  });

  app.get(
    '/api/health',
    asyncHandler(async (req, res) => {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    }),
  );

  app.use('/api/auth', authRoutes);
  app.use('/api/users', authenticate, userRoutes);
  app.use('/api/cases', authenticate, caseRoutes);
  app.use('/api/evidence', authenticate, evidenceRoutes);
  app.use('/api/transfers', authenticate, transferRoutes);
  app.use('/api/audit', authenticate, auditRoutes);
  app.use('/api/alerts', authenticate, alertRoutes);
  app.use('/api/dashboard', authenticate, dashboardRoutes);

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
