const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const router = express.Router();
const { optionalAuth, verifyToken, requireTeamMember, requireAdmin } = require('../middleware/auth');
const { sendInventoryCheckoutEmail } = require('../services/emailService');
const Equipment = require('../models/Equipment');
const EquipmentCategory = require('../models/EquipmentCategory');
const { asyncHandler, validationErrorHandler, notFoundErrorHandler } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const equipmentFields = [
  'name', 'description', 'categoryId', 'modelNumber', 'serialNumber', 'manufacturer',
  'purchaseDate', 'purchasePrice', 'currentQuantity', 'minQuantity', 'maxQuantity',
  'location', 'status', 'imageUrl', 'specifications', 'maintenanceSchedule',
  'lastMaintenanceDate', 'nextMaintenanceDate',
];

const equipmentOptionalValidators = [
  body('name').optional().isString().trim().isLength({ min: 2, max: 255 }),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 2000 }),
  body('categoryId').optional().isMongoId(),
  body('modelNumber').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
  body('serialNumber').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
  body('manufacturer').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
  body('purchaseDate').optional({ nullable: true }).isISO8601().toDate(),
  body('purchasePrice').optional({ nullable: true }).isFloat({ min: 0 }).toFloat(),
  body('currentQuantity').optional().isInt({ min: 0 }).toInt(),
  body('minQuantity').optional().isInt({ min: 0 }).toInt(),
  body('maxQuantity').optional({ nullable: true }).isInt({ min: 0 }).toInt(),
  body('location').optional({ nullable: true }).isString().trim().isLength({ max: 255 }),
  body('status').optional().isIn(['available', 'low_stock', 'out_of_stock', 'maintenance', 'retired']),
  body('imageUrl').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  body('specifications').optional().isObject(),
  body('maintenanceSchedule').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  body('lastMaintenanceDate').optional({ nullable: true }).isISO8601().toDate(),
  body('nextMaintenanceDate').optional({ nullable: true }).isISO8601().toDate(),
];

function pickEquipmentFields(input) {
  return Object.fromEntries(equipmentFields
    .filter((field) => Object.prototype.hasOwnProperty.call(input, field))
    .map((field) => [field, input[field]]));
}

// TODO: Implement inventory routes
// - GET /api/inventory/equipment - List equipment
// - GET /api/inventory/equipment/:id - Get equipment details
// - POST /api/inventory/equipment - Create equipment
// - PUT /api/inventory/equipment/:id - Update equipment
// - DELETE /api/inventory/equipment/:id - Delete equipment
// - GET /api/inventory/categories - List equipment categories
// - POST /api/inventory/equipment/:id/checkout - Checkout equipment
// - PUT /api/inventory/equipment/:id/return - Return equipment
// - POST /api/inventory/equipment/:id/urgent-checkout - Urgent checkout (records even if stock insufficient)

// Equipment list with filters
router.get(
  '/equipment',
  optionalAuth,
  [
    query('categoryId').optional().isMongoId(),
    query('status').optional().isIn(['available', 'low_stock', 'out_of_stock', 'maintenance', 'retired']),
    query('q').optional().isString().trim().isLength({ max: 100 }),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('skip').optional().isInt({ min: 0 }).toInt(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);
    const { categoryId, status, q, limit = 20, skip = 0 } = req.query;
    const filter = {};
    if (categoryId) filter.categoryId = categoryId;
    if (status) filter.status = status;
    if (q) filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [items, total] = await Promise.all([
      Equipment.find(filter).limit(limit).skip(skip).sort({ createdAt: -1 }),
      Equipment.countDocuments(filter),
    ]);
    res.json({ success: true, data: { items, pagination: { total, limit, skip, hasMore: total > skip + items.length } } });
  })
);

// Resolve an opaque printed QR identifier to its inventory item.
router.get('/equipment/qr/:qrCodeId', asyncHandler(async (req, res) => {
  const qrCodeId = String(req.params.qrCodeId || '');
  if (!/^NB-[A-F0-9]{24}$/.test(qrCodeId)) return res.status(404).json({ success: false, message: 'QR code not found' });
  const item = await Equipment.findOne({ qrCodeId }).select('-checkouts');
  if (!item) throw notFoundErrorHandler('Equipment');
  res.json({ success: true, data: { item } });
}));

// Equipment get by id
router.get(
  '/equipment/:id',
  [param('id').isMongoId()],
  asyncHandler(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return next(validationErrorHandler(errors));
    return next();
  }),
  asyncHandler(async (req, res) => {
    const eq = await Equipment.findById(req.params.id);
    if (!eq) throw notFoundErrorHandler('Equipment');
    res.json({ success: true, data: { item: eq } });
  })
);

// Component management is handled through the admin dashboard.
router.post(
  '/equipment',
  verifyToken,
  requireAdmin,
  [
    body('name').isString().trim().isLength({ min: 2, max: 255 }),
    body('categoryId').isMongoId(),
    ...equipmentOptionalValidators,
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);
    if (!(await EquipmentCategory.exists({ _id: req.body.categoryId }))) throw notFoundErrorHandler('Category');
    const created = await Equipment.create(pickEquipmentFields(req.body));
    res.status(201).json({ success: true, message: 'Equipment created', data: { item: created } });
  })
);

router.put(
  '/equipment/:id',
  verifyToken,
  requireAdmin,
  [param('id').isMongoId(), ...equipmentOptionalValidators],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);
    const changes = pickEquipmentFields(req.body);
    delete changes.currentQuantity; // Stock is changed only through the audited adjustment endpoint.
    if (!Object.keys(changes).length) return res.status(400).json({ success: false, message: 'At least one equipment field is required' });
    if (changes.categoryId && !(await EquipmentCategory.exists({ _id: changes.categoryId }))) throw notFoundErrorHandler('Category');
    const updated = await Equipment.findByIdAndUpdate(req.params.id, changes, { new: true, runValidators: true });
    if (!updated) throw notFoundErrorHandler('Equipment');
    res.json({ success: true, message: 'Equipment updated', data: { item: updated } });
  })
);

router.post(
  '/equipment/:id/adjust-stock',
  verifyToken,
  requireAdmin,
  [
    param('id').isMongoId(),
    body('delta').isInt({ min: -100000, max: 100000 }).toInt().custom((value) => value !== 0),
    body('reason').isString().trim().isLength({ min: 3, max: 1000 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);
    const { delta, reason } = req.body;
    const filter = { _id: req.params.id };
    if (delta < 0) filter.currentQuantity = { $gte: Math.abs(delta) };
    const updated = await Equipment.findOneAndUpdate(
      filter,
      {
        $inc: { currentQuantity: delta },
        $push: { stockMovements: {
          delta,
          reason: reason.trim(),
          performedBy: req.user.id,
          performedAt: new Date(),
          type: 'adjustment',
        } },
      },
      { new: true, runValidators: true },
    ).select('-checkouts');
    if (!updated) {
      const exists = await Equipment.exists({ _id: req.params.id });
      if (!exists) throw notFoundErrorHandler('Equipment');
      throw new ApiError(409, 'Stock adjustment would make available quantity negative');
    }
    res.json({ success: true, message: 'Stock adjusted and audit entry recorded', data: { item: updated } });
  }),
);

router.delete(
  '/equipment/:id',
  verifyToken,
  requireAdmin,
  [param('id').isMongoId()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);
    const deleted = await Equipment.findByIdAndDelete(req.params.id);
    if (!deleted) throw notFoundErrorHandler('Equipment');
    res.json({ success: true, message: 'Equipment deleted' });
  })
);

// POST /api/inventory/equipment/:id/checkout - Checkout equipment (team members+)
router.post(
  '/equipment/:id/checkout',
  verifyToken,
  requireAdmin,
  [
    param('id').isString(),
    body('quantity').isInt({ min: 1 }).toInt(),
    body('userId').optional().isString(), // If admin/inventory manager checking out for someone else
    body('expectedReturnDate').optional().isISO8601().toDate(),
    body('projectId').optional().isString(), // If for a project
    body('checkoutNotes').optional().isString().isLength({ max: 1000 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);

    const equipment = await Equipment.findById(req.params.id);
    if (!equipment) throw notFoundErrorHandler('Equipment');

    const quantity = Math.max(1, Number(req.body.quantity || 1));
    const checkoutUserId = req.body.userId || req.user.id; // Allow admins to checkout for others
    const expectedReturnDate = req.body.expectedReturnDate ? new Date(req.body.expectedReturnDate) : null;
    const projectId = req.body.projectId || null;
    const checkoutNotes = req.body.checkoutNotes || null;

    // Get user info for snapshot
    const User = require('../models/User');
    const checkoutUser = await User.findById(checkoutUserId).select('firstName lastName email');
    if (!checkoutUser) throw notFoundErrorHandler('User');

    // Get project info if provided
    let projectName = null;
    if (projectId) {
      const Project = require('../models/Project');
      const project = await Project.findById(projectId).select('title');
      if (project) projectName = project.title;
    }

    // Check if sufficient quantity available
    if (equipment.currentQuantity < quantity) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient quantity available',
        data: { available: equipment.currentQuantity, requested: quantity }
      });
    }

    // Create checkout record
    const checkoutData = {
      userId: checkoutUserId,
      quantity,
      checkoutDate: new Date(),
      expectedReturnDate,
      checkoutNotes,
      status: projectId ? 'project_use' : 'checked_out',
      projectId,
      projectName,
      userNameSnapshot: `${checkoutUser.firstName} ${checkoutUser.lastName}`.trim() || checkoutUser.email,
      checkedOutBy: req.user.id, // Track who processed the checkout
    };

    equipment.currentQuantity -= quantity;
    equipment.checkouts.push(checkoutData);
    await equipment.save();

    // Send email notification
    try {
      await sendInventoryCheckoutEmail({
        equipment,
        userEmail: checkoutUser.email,
        quantity,
        expectedReturnDate,
      });
    } catch (emailError) {
      logger.warn('Failed to send checkout email', { error: emailError.message });
    }

    // Get the created checkout ID
    const createdCheckout = equipment.checkouts[equipment.checkouts.length - 1];

    res.status(201).json({
      success: true,
      message: 'Equipment checked out successfully',
      data: {
        checkout: {
          id: createdCheckout._id,
          userId: checkoutUserId,
          userName: checkoutData.userNameSnapshot,
          quantity,
          checkoutDate: checkoutData.checkoutDate,
          expectedReturnDate,
          projectId,
          projectName,
          status: checkoutData.status,
        },
        equipment: {
          id: equipment._id,
          name: equipment.name,
          currentQuantity: equipment.currentQuantity,
        },
      },
    });
  })
);

// Urgent checkout: records usage even when stock is insufficient
router.post(
  '/equipment/:id/urgent-checkout',
  verifyToken,
  requireAdmin,
  [
    param('id').isString(),
    body('quantity').optional().isInt({ min: 1 }).toInt(),
    body('expectedReturnDate').optional().isISO8601().toDate(),
    body('notes').optional().isString().isLength({ max: 1000 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);

    const equipment = await Equipment.findById(req.params.id);
    if (!equipment) throw notFoundErrorHandler('Equipment');

    const requested = Math.max(1, Number(req.body.quantity || 1));
    const availableNow = Math.max(0, Number(equipment.currentQuantity || 0));
    const fulfilled = Math.min(requested, availableNow);
    const overdrawn = Math.max(0, requested - fulfilled);
    const expectedReturnDate = req.body.expectedReturnDate || new Date(Date.now() + 7*24*60*60*1000);

    // Reduce only what is available; never below zero
    equipment.currentQuantity = availableNow - fulfilled;
    equipment.checkouts.push({
      userId: req.user.id,
      quantity: requested, // store the requested as the primary quantity
      expectedReturnDate,
      checkoutNotes: req.body.notes,
      isUrgent: true,
      requestedQuantity: requested,
      fulfilledQuantity: fulfilled,
      overdrawnQuantity: overdrawn,
      userNameSnapshot: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email,
    });

    await equipment.save();

    res.status(201).json({
      success: true,
      message: 'Urgent checkout recorded',
      data: {
        currentQuantity: equipment.currentQuantity,
        requestedQuantity: requested,
        fulfilledQuantity: fulfilled,
        overdrawnQuantity: overdrawn,
      },
    });
  })
);

// PUT /api/inventory/equipment/:id/return - Return equipment (team members+)
router.put(
  '/equipment/:id/return',
  verifyToken,
  requireAdmin,
  [
    param('id').isString(),
    body('checkoutId').optional().isString(),
    body('returnNotes').optional().isString().isLength({ max: 1000 }),
    body('quantity').optional().isInt({ min: 1 }).toInt(), // Allow partial returns
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);

    const equipment = await Equipment.findById(req.params.id);
    if (!equipment) throw notFoundErrorHandler('Equipment');

    // Find checkout to return
    let checkoutIdx = -1;
    if (req.body.checkoutId) {
      checkoutIdx = equipment.checkouts.findIndex(c => String(c._id) === String(req.body.checkoutId));
    } else {
      // Find last active checkout by this user
      for (let i = equipment.checkouts.length - 1; i >= 0; i -= 1) {
        const c = equipment.checkouts[i];
        if (String(c.userId) === String(req.user.id) && ['checked_out', 'overdue', 'project_use'].includes(c.status)) {
          checkoutIdx = i;
          break;
        }
      }
    }

    if (checkoutIdx === -1) {
      return res.status(404).json({
        success: false,
        message: 'Active checkout not found',
      });
    }

    const checkout = equipment.checkouts[checkoutIdx];

    // Check if already returned
    if (checkout.status === 'returned') {
      return res.status(400).json({
        success: false,
        message: 'This checkout has already been returned',
      });
    }

    // Handle partial returns
    const returnQuantity = req.body.quantity || checkout.quantity;
    if (returnQuantity > checkout.quantity) {
      return res.status(400).json({
        success: false,
        message: `Cannot return more than checked out. Checked out: ${checkout.quantity}, attempting to return: ${returnQuantity}`,
      });
    }

    // Update checkout status
    checkout.status = 'returned';
    checkout.actualReturnDate = new Date();
    checkout.returnNotes = req.body.returnNotes || checkout.returnNotes;
    checkout.returnedBy = req.user.id; // Track who processed the return

    // If partial return, update quantities
    if (returnQuantity < checkout.quantity) {
      checkout.quantity -= returnQuantity;
      equipment.currentQuantity += returnQuantity;
      // Create a new checkout record for remaining quantity
      const remainingCheckout = {
        ...checkout.toObject(),
        _id: undefined,
        status: checkout.status === 'project_use' ? 'project_use' : 'checked_out',
        actualReturnDate: undefined,
        returnNotes: undefined,
        returnedBy: undefined,
      };
      equipment.checkouts.push(remainingCheckout);
    } else {
      // Full return
      equipment.currentQuantity += returnQuantity;
    }

    await equipment.save();

    res.json({
      success: true,
      message: 'Equipment returned successfully',
      data: {
        checkout: {
          id: checkout._id,
          returnedQuantity: returnQuantity,
          actualReturnDate: checkout.actualReturnDate,
          status: checkout.status,
        },
        equipment: {
          id: equipment._id,
          name: equipment.name,
          currentQuantity: equipment.currentQuantity,
        },
      },
    });
  })
);

// GET /api/inventory/checkouts - List all checkouts with filters (team members+)
router.get(
  '/checkouts',
  verifyToken,
  requireAdmin,
  [
    query('equipmentId').optional().isString(),
    query('userId').optional().isString(),
    query('projectId').optional().isString(),
    query('status').optional().isIn(['checked_out', 'returned', 'overdue', 'lost', 'project_use']),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('skip').optional().isInt({ min: 0 }).toInt(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);

    const { equipmentId, userId, projectId, status, limit = 20, skip = 0 } = req.query;

    // Build query to find equipment with matching checkouts
    const equipmentFilter = {};
    if (equipmentId) equipmentFilter._id = equipmentId;

    const equipments = await Equipment.find(equipmentFilter).select('name categoryId checkouts');

    // Filter checkouts
    let allCheckouts = [];
    equipments.forEach(equipment => {
      equipment.checkouts.forEach(checkout => {
        const checkoutObj = checkout.toObject();
        checkoutObj.equipmentId = equipment._id;
        checkoutObj.equipmentName = equipment.name;
        allCheckouts.push(checkoutObj);
      });
    });

    // Apply filters
    if (userId) allCheckouts = allCheckouts.filter(c => String(c.userId) === String(userId));
    if (projectId) allCheckouts = allCheckouts.filter(c => c.projectId && String(c.projectId) === String(projectId));
    if (status) allCheckouts = allCheckouts.filter(c => c.status === status);

    // Sort by checkout date (newest first)
    allCheckouts.sort((a, b) => new Date(b.checkoutDate) - new Date(a.checkoutDate));

    // Paginate
    const total = allCheckouts.length;
    const paginatedCheckouts = allCheckouts.slice(skip, skip + limit);

    res.json({
      success: true,
      data: {
        items: paginatedCheckouts,
        pagination: {
          total,
          limit: parseInt(limit),
          skip: parseInt(skip),
          hasMore: total > skip + paginatedCheckouts.length,
        },
      },
    });
  })
);

// GET /api/inventory/checkouts/my - Get current user's checkout history (team members+)
router.get(
  '/checkouts/my',
  verifyToken,
  requireTeamMember,
  [
    query('status').optional().isIn(['checked_out', 'returned', 'overdue', 'lost', 'project_use']),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('skip').optional().isInt({ min: 0 }).toInt(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);

    const { status, limit = 20, skip = 0 } = req.query;
    const userId = req.user.id;

    // Find all equipment and filter checkouts by userId
    const equipments = await Equipment.find({}).select('name categoryId checkouts');

    let userCheckouts = [];
    equipments.forEach(equipment => {
      equipment.checkouts.forEach(checkout => {
        if (String(checkout.userId) === String(userId)) {
          const checkoutObj = checkout.toObject();
          checkoutObj.equipmentId = equipment._id;
          checkoutObj.equipmentName = equipment.name;
          if (!status || checkoutObj.status === status) {
            userCheckouts.push(checkoutObj);
          }
        }
      });
    });

    // Sort by checkout date (newest first)
    userCheckouts.sort((a, b) => new Date(b.checkoutDate) - new Date(a.checkoutDate));

    // Paginate
    const total = userCheckouts.length;
    const paginatedCheckouts = userCheckouts.slice(skip, skip + limit);

    res.json({
      success: true,
      data: {
        items: paginatedCheckouts,
        pagination: {
          total,
          limit: parseInt(limit),
          skip: parseInt(skip),
          hasMore: total > skip + paginatedCheckouts.length,
        },
      },
    });
  })
);

// GET /api/inventory/equipment/:id/checkouts - Get all checkouts for specific equipment (team members+)
router.get(
  '/equipment/:id/checkouts',
  verifyToken,
  requireAdmin,
  [
    param('id').isString(),
    query('status').optional().isIn(['checked_out', 'returned', 'overdue', 'lost', 'project_use']),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('skip').optional().isInt({ min: 0 }).toInt(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw validationErrorHandler(errors);

    const equipment = await Equipment.findById(req.params.id).select('name checkouts');
    if (!equipment) throw notFoundErrorHandler('Equipment');

    let checkouts = equipment.checkouts.map(c => c.toObject());

    // Filter by status if provided
    if (req.query.status) {
      checkouts = checkouts.filter(c => c.status === req.query.status);
    }

    // Sort by checkout date (newest first)
    checkouts.sort((a, b) => new Date(b.checkoutDate) - new Date(a.checkoutDate));

    // Paginate
    const total = checkouts.length;
    const limit = parseInt(req.query.limit || 20);
    const skip = parseInt(req.query.skip || 0);
    const paginatedCheckouts = checkouts.slice(skip, skip + limit);

    res.json({
      success: true,
      data: {
        equipment: {
          id: equipment._id,
          name: equipment.name,
        },
        items: paginatedCheckouts,
        pagination: {
          total,
          limit,
          skip,
          hasMore: total > skip + paginatedCheckouts.length,
        },
      },
    });
  })
);

// GET /api/inventory/equipment/:id/checkouts/active - Get active checkouts for equipment (team members+)
router.get(
  '/equipment/:id/checkouts/active',
  verifyToken,
  requireAdmin,
  [param('id').isString()],
  asyncHandler(async (req, res) => {
    const equipment = await Equipment.findById(req.params.id).select('name checkouts');
    if (!equipment) throw notFoundErrorHandler('Equipment');

    const activeCheckouts = equipment.checkouts
      .filter(c => ['checked_out', 'overdue', 'project_use'].includes(c.status))
      .map(c => c.toObject());

    // Sort by checkout date (newest first)
    activeCheckouts.sort((a, b) => new Date(b.checkoutDate) - new Date(a.checkoutDate));

    res.json({
      success: true,
      data: {
        equipment: {
          id: equipment._id,
          name: equipment.name,
        },
        activeCheckouts,
        count: activeCheckouts.length,
      },
    });
  })
);

// GET /api/inventory/checkouts/:checkoutId - Get specific checkout details (team members+)
router.get(
  '/checkouts/:checkoutId',
  verifyToken,
  requireTeamMember,
  [param('checkoutId').isString()],
  asyncHandler(async (req, res) => {
    const { checkoutId } = req.params;

    // Search through all equipment to find the checkout
    const equipments = await Equipment.find({}).select('name categoryId checkouts');

    for (const equipment of equipments) {
      const checkout = equipment.checkouts.id(checkoutId);
      if (checkout) {
        // Check if user has permission (must be the checkout user or admin/inventory manager)
        const isOwner = String(checkout.userId) === String(req.user.id);
        const isAdmin = req.user.role === 'admin';
        const isInventoryManager = req.user.subroles && req.user.subroles.includes('inventory_manager');

        if (!isOwner && !isAdmin && !isInventoryManager) {
          return res.status(403).json({
            success: false,
            message: 'Access denied. You can only view your own checkouts.',
          });
        }

        const checkoutObj = checkout.toObject();
        checkoutObj.equipmentId = equipment._id;
        checkoutObj.equipmentName = equipment.name;

        return res.json({
          success: true,
          data: {
            checkout: checkoutObj,
          },
        });
      }
    }

    throw notFoundErrorHandler('Checkout');
  })
);

// Categories CRUD
router.get('/categories', optionalAuth, asyncHandler(async (req, res) => {
  const items = await EquipmentCategory.find({}).sort({ name: 1 });
  res.json({ success: true, data: { items } });
}));

router.post('/categories', verifyToken, requireAdmin, [
  body('name').isString().trim().isLength({ min: 2, max: 100 }),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  body('parentCategoryId').optional({ nullable: true, checkFalsy: true }).isMongoId(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw validationErrorHandler(errors);
  if (req.body.parentCategoryId && !(await EquipmentCategory.exists({ _id: req.body.parentCategoryId }))) throw notFoundErrorHandler('Parent category');
  const created = await EquipmentCategory.create({
    name: req.body.name,
    description: req.body.description,
    parentCategoryId: req.body.parentCategoryId || undefined,
  });
  res.status(201).json({ success: true, message: 'Category created', data: { item: created } });
}));

router.put('/categories/:id', verifyToken, requireAdmin, [
  param('id').isMongoId(),
  body('name').optional().isString().trim().isLength({ min: 2, max: 100 }),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  body('parentCategoryId').optional({ nullable: true, checkFalsy: true }).isMongoId(),
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw validationErrorHandler(errors);
  const changes = {};
  ['name', 'description', 'parentCategoryId'].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) changes[field] = req.body[field];
  });
  if (!Object.keys(changes).length) return res.status(400).json({ success: false, message: 'At least one category field is required' });
  if (changes.parentCategoryId && !(await EquipmentCategory.exists({ _id: changes.parentCategoryId }))) throw notFoundErrorHandler('Parent category');
  const updated = await EquipmentCategory.findByIdAndUpdate(req.params.id, changes, { new: true, runValidators: true });
  if (!updated) throw notFoundErrorHandler('Category');
  res.json({ success: true, message: 'Category updated', data: { item: updated } });
}));

router.delete('/categories/:id', verifyToken, requireAdmin, [param('id').isMongoId()], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) throw validationErrorHandler(errors);
  const deleted = await EquipmentCategory.findByIdAndDelete(req.params.id);
  if (!deleted) throw notFoundErrorHandler('Category');
  res.json({ success: true, message: 'Category deleted' });
}));

module.exports = router;
