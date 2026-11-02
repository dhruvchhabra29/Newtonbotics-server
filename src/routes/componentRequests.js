const express = require('express');
const mongoose = require('mongoose');
const { body, param, query, validationResult } = require('express-validator');
const { verifyToken } = require('../middleware/auth');
const { asyncHandler, validationErrorHandler, notFoundErrorHandler, authorizationErrorHandler, conflictErrorHandler, ApiError } = require('../middleware/errorHandler');
const ComponentRequest = require('../models/ComponentRequest');
const Equipment = require('../models/Equipment');
const InventoryTransfer = require('../models/InventoryTransfer');
const Project = require('../models/Project');
const ProjectComponent = require('../models/ProjectComponent');

const router = express.Router();
const validId = (value) => mongoose.Types.ObjectId.isValid(value);
const hasPermission = (user, permissions) => (user?.permissions || []).some((permission) => permissions.includes(permission));
const canReview = (user) => user && (user.role === 'admin' || hasPermission(user, ['system:admin']));
const checkValidation = (req) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw validationErrorHandler(errors);
};
const auditEntry = (action, userId, changes, req, reason) => ({
  action,
  performedBy: userId,
  performedAt: new Date(),
  changes,
  reason,
  ipAddress: req.ip,
  userAgent: req.get('User-Agent'),
});
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const requestIdParam = param('id').custom(validId).withMessage('Invalid request ID');
const listValidators = [
  query('status').optional().isIn(['pending', 'approved', 'rejected']),
  query('projectId').optional().custom(validId).withMessage('Invalid project ID'),
  query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  query('skip').optional().isInt({ min: 0 }).toInt(),
];

router.post('/', verifyToken, [
  body('projectId').optional({ nullable: true, checkFalsy: true }).custom(validId).withMessage('Invalid project ID'),
  body('equipmentId').optional({ nullable: true, checkFalsy: true }).custom(validId).withMessage('Invalid equipment ID'),
  body('componentName').optional().isString().trim().isLength({ min: 2, max: 255 }),
  body('quantity').isInt({ min: 1 }).toInt(),
  body('purpose').isString().trim().isLength({ min: 1, max: 2000 }),
], asyncHandler(async (req, res) => {
  checkValidation(req);
  const project = req.body.projectId ? await Project.findById(req.body.projectId).select('title') : null;
  if (req.body.projectId && !project) throw notFoundErrorHandler('Project');

  let equipment = null;
  if (req.body.equipmentId) {
    equipment = await Equipment.findById(req.body.equipmentId).select('name');
    if (!equipment) throw notFoundErrorHandler('General Lab component');
  }
  const componentName = equipment?.name || req.body.componentName?.trim();
  if (!componentName) throw validationErrorHandler({ array: () => [{ msg: 'Component name is required when equipmentId is omitted' }] });

  const request = await ComponentRequest.create({
    requesterId: req.user.id,
    projectId: project?._id || null,
    equipmentId: equipment?._id || null,
    componentName,
    quantity: req.body.quantity,
    purpose: req.body.purpose.trim(),
    auditTrail: [auditEntry('created', req.user.id, { requesterId: req.user.id, projectId: project?._id || null, componentName, quantity: req.body.quantity, purpose: req.body.purpose.trim() }, req)],
  });
  res.status(201).json({ success: true, message: 'Component request submitted', data: { request } });
}));

router.get('/my-requests', verifyToken, listValidators, asyncHandler(async (req, res) => {
  checkValidation(req);
  const { status, limit = 50, skip = 0 } = req.query;
  const filter = { requesterId: req.user.id };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    ComponentRequest.find(filter).populate('projectId', 'title').populate('reviewerId', 'firstName lastName email').sort({ createdAt: -1 }).limit(limit).skip(skip),
    ComponentRequest.countDocuments(filter),
  ]);
  res.json({ success: true, data: { items, pagination: { total, limit, skip, hasMore: total > skip + items.length } } });
}));

router.get('/', verifyToken, listValidators, asyncHandler(async (req, res) => {
  checkValidation(req);
  if (!canReview(req.user)) throw authorizationErrorHandler('Component request reviewer permission required');
  const { status, projectId, limit = 100, skip = 0 } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (projectId) filter.projectId = projectId;
  const [items, total] = await Promise.all([
    ComponentRequest.find(filter)
      .populate('requesterId', 'firstName lastName email')
      .populate('projectId', 'title')
      .populate('reviewerId', 'firstName lastName email')
      .populate('auditTrail.performedBy', 'firstName lastName email role')
      .sort({ createdAt: -1 }).limit(limit).skip(skip),
    ComponentRequest.countDocuments(filter),
  ]);
  res.json({ success: true, data: { items, pagination: { total, limit, skip, hasMore: total > skip + items.length } } });
}));

router.get('/:id', verifyToken, [requestIdParam], asyncHandler(async (req, res) => {
  checkValidation(req);
  const request = await ComponentRequest.findById(req.params.id)
    .populate('requesterId', 'firstName lastName email')
    .populate('projectId', 'title')
    .populate('reviewerId', 'firstName lastName email')
    .populate('auditTrail.performedBy', 'firstName lastName email role');
  if (!request) throw notFoundErrorHandler('Component request');
  if (request.requesterId._id.toString() !== req.user.id.toString() && !canReview(req.user)) {
    throw authorizationErrorHandler('You cannot view another user’s component request');
  }
  res.json({ success: true, data: { request } });
}));

router.post('/:id/approve', verifyToken, [requestIdParam, body('reviewNotes').optional({ nullable: true }).isString().isLength({ max: 2000 })], asyncHandler(async (req, res) => {
  checkValidation(req);
  if (!canReview(req.user)) throw authorizationErrorHandler('Component request reviewer permission required');

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const request = await ComponentRequest.findById(req.params.id).session(session);
      if (!request) throw notFoundErrorHandler('Component request');
      if (request.status !== 'pending') throw conflictErrorHandler('Only pending component requests can be approved');
      if (String(request.requesterId) === String(req.user.id)) throw authorizationErrorHandler('You cannot approve your own component request');

      const project = request.projectId ? await Project.findById(request.projectId).select('title').session(session) : null;
      if (request.projectId && !project) throw notFoundErrorHandler('Project');

      let sourceEquipment;
      if (request.equipmentId) {
        sourceEquipment = await Equipment.findById(request.equipmentId).populate('categoryId', 'name').session(session);
      } else {
        const matches = await Equipment.find({ name: new RegExp(`^${escapeRegex(request.componentName)}$`, 'i') }).populate('categoryId', 'name').session(session);
        if (matches.length > 1) throw conflictErrorHandler('Multiple General Lab items match this component name; submit the request with a specific equipmentId');
        sourceEquipment = matches[0];
      }
      if (!sourceEquipment) throw notFoundErrorHandler('Matching General Lab component');

      const transferTime = new Date();
      const updatedEquipment = await Equipment.findOneAndUpdate(
        { _id: sourceEquipment._id, currentQuantity: { $gte: request.quantity } },
        { $inc: { currentQuantity: -request.quantity } },
        { new: true, session, runValidators: true },
      );
      if (!updatedEquipment) throw new ApiError(409, 'Insufficient General Lab stock to approve this request');

      const componentName = sourceEquipment.name;
      const nameKey = componentName.trim().toLowerCase();
      let projectComponent = null;
      if (request.projectId) {
        projectComponent = await ProjectComponent.findOneAndUpdate(
          { projectId: request.projectId, nameKey, isDeleted: false },
          {
            $inc: { quantity: request.quantity },
            $setOnInsert: {
              projectId: request.projectId,
              name: componentName,
              nameKey,
              category: sourceEquipment.categoryId?.name || 'Uncategorized',
              minimumQuantity: 0,
              location: sourceEquipment.location || '',
              description: sourceEquipment.description || '',
              isDeleted: false,
            },
            $push: { auditTrail: {
              action: 'updated',
              performedBy: req.user.id,
              performedAt: transferTime,
              changes: { source: 'component_request', requestId: request._id, quantityAdded: request.quantity },
              ipAddress: req.ip,
              userAgent: req.get('User-Agent'),
            } },
          },
          { new: true, upsert: true, session, runValidators: true, setDefaultsOnInsert: true },
        );
      }

      const transfer = request.projectId ? await InventoryTransfer.create([{
        requestId: request._id,
        requesterId: request.requesterId,
        projectId: request.projectId,
        equipmentId: sourceEquipment._id,
        componentId: projectComponent._id,
        componentName,
        quantity: request.quantity,
        approvedBy: req.user.id,
        transferredAt: transferTime,
      }], { session }) : [];

      const approvedRequest = await ComponentRequest.findOneAndUpdate(
        { _id: request._id, status: 'pending' },
        {
          $set: { status: 'approved', reviewerId: req.user.id, reviewNotes: req.body.reviewNotes?.trim() || '', approvedQuantity: request.quantity, reviewedAt: transferTime },
          $push: { auditTrail: auditEntry('approved', req.user.id, {
            requesterId: request.requesterId,
            projectId: request.projectId,
            componentName,
            equipmentId: sourceEquipment._id,
            projectComponentId: projectComponent?._id || null,
            quantity: request.quantity,
            approvedBy: req.user.id,
            transferredAt: transferTime,
          }, req, req.body.reviewNotes?.trim() || null) },
        },
        { new: true, session, runValidators: true },
      );
      if (!approvedRequest) throw conflictErrorHandler('This component request has already been reviewed');

      result = { request: approvedRequest, transfer: transfer[0] || null, sourceEquipment: updatedEquipment, projectComponent };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
  } finally {
    await session.endSession();
  }

  res.json({ success: true, message: result.transfer ? 'Request approved and inventory transferred to project' : 'Request approved and stock issued', data: result });
}));

router.post('/:id/reject', verifyToken, [requestIdParam, body('reviewNotes').optional({ nullable: true }).isString().isLength({ max: 2000 })], asyncHandler(async (req, res) => {
  checkValidation(req);
  if (!canReview(req.user)) throw authorizationErrorHandler('Component request reviewer permission required');
  const reviewedAt = new Date();
  const request = await ComponentRequest.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    {
      $set: { status: 'rejected', reviewerId: req.user.id, reviewNotes: req.body.reviewNotes?.trim() || '', reviewedAt },
      $push: { auditTrail: auditEntry('rejected', req.user.id, { requesterId: undefined, projectId: undefined, componentName: undefined, quantity: undefined, rejectedBy: req.user.id, reviewedAt }, req, req.body.reviewNotes?.trim() || null) },
    },
    { new: true, runValidators: true },
  ).populate('requesterId', 'firstName lastName email').populate('projectId', 'title');
  if (request && String(request.requesterId?._id || request.requesterId) === String(req.user.id)) {
    throw authorizationErrorHandler('You cannot reject your own component request');
  }
  if (!request) {
    const existing = await ComponentRequest.findById(req.params.id).select('status');
    if (!existing) throw notFoundErrorHandler('Component request');
    throw conflictErrorHandler('Only pending component requests can be rejected');
  }
  request.auditTrail[request.auditTrail.length - 1].changes = {
    requesterId: request.requesterId._id,
    projectId: request.projectId?._id || null,
    componentName: request.componentName,
    quantity: request.quantity,
    rejectedBy: req.user.id,
    reviewedAt,
  };
  await request.save();
  res.json({ success: true, message: 'Request rejected', data: { request } });
}));

module.exports = router;