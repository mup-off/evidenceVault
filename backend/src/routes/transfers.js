'use strict';

const express = require('express');

const { asyncHandler } = require('../errors');
const { requireRole } = require('../middleware/auth');
const { denyAccess } = require('../services/access');
const custody = require('../services/custody');
const validate = require('../validate');

const router = express.Router();

// The user's own transfers. direction: incoming | outgoing | mine (default) | all.
// "all" is for administrators and auditors.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status
      ? validate.oneOf(req.query.status, 'status', ['pending', 'accepted', 'rejected', 'cancelled'])
      : null;
    const direction = req.query.direction
      ? validate.oneOf(req.query.direction, 'direction', ['incoming', 'outgoing', 'mine', 'all'])
      : 'mine';
    if (direction === 'all' && !['administrator', 'auditor'].includes(req.user.role)) {
      throw await denyAccess(req, `role ${req.user.role} may not list every custody transfer`);
    }
    res.json({ transfers: await custody.list(req.user, { status, direction }) });
  }),
);

function noteFrom(req) {
  const input = req.body && typeof req.body === 'object' ? req.body : {};
  return validate.string(input.note, 'note', { optional: true, max: 1000 });
}

for (const decision of ['accept', 'reject', 'cancel']) {
  router.post(
    `/:id/${decision}`,
    requireRole('administrator', 'investigator', 'custodian'),
    asyncHandler(async (req, res) => {
      const transfer = await custody.decide(req, validate.id(req.params.id), decision, noteFrom(req));
      res.json({ transfer });
    }),
  );
}

module.exports = router;
