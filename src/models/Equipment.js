const mongoose = require('mongoose');
const crypto = require('crypto');

const checkoutSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  quantity: { type: Number, required: true, min: 1 },
  checkoutDate: { type: Date, default: Date.now, required: true },
  expectedReturnDate: { type: Date }, // Optional - if null, item may never return (e.g., for projects)
  actualReturnDate: { type: Date },
  checkoutNotes: { type: String, maxlength: 1000 },
  returnNotes: { type: String, maxlength: 1000 },
  status: { type: String, enum: ['checked_out', 'returned', 'overdue', 'lost', 'project_use'], default: 'checked_out' },
  // Project association - if item is for a project, it may never return
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  projectName: { type: String, maxlength: 255, trim: true }, // Snapshot for historical records
  // Urgent checkout fields
  isUrgent: { type: Boolean, default: false },
  requestedQuantity: { type: Number, min: 1 },
  fulfilledQuantity: { type: Number, min: 0 },
  overdrawnQuantity: { type: Number, min: 0, default: 0 },
  userNameSnapshot: { type: String, maxlength: 255, trim: true },
  // Checkout metadata
  checkedOutBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Admin/inventory manager who processed checkout
  returnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Admin/inventory manager who processed return
});

const stockMovementSchema = new mongoose.Schema({
  delta: { type: Number, required: true, validate: Number.isInteger },
  reason: { type: String, required: true, trim: true, maxlength: 1000 },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  performedAt: { type: Date, default: Date.now, required: true },
  type: { type: String, enum: ['adjustment', 'request_approval', 'return', 'opening_balance'], default: 'adjustment' },
}, { _id: true });

const equipmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 255, trim: true },
    // Stable opaque identifier for printed QR labels; never encodes permissions or user data.
    qrCodeId: { type: String, unique: true, sparse: true, immutable: true, index: true },
    description: { type: String, maxlength: 2000, trim: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'EquipmentCategory', required: true },
    modelNumber: { type: String, maxlength: 100, trim: true },
    serialNumber: { type: String, maxlength: 100, unique: true, sparse: true, trim: true },
    manufacturer: { type: String, maxlength: 100, trim: true },
    purchaseDate: { type: Date },
    purchasePrice: { type: Number, min: 0 },
    currentQuantity: { type: Number, required: true, default: 0, min: 0 },
    minQuantity: { type: Number, default: 0, min: 0 },
    maxQuantity: { type: Number, min: 0 },
    location: { type: String, maxlength: 255, trim: true },
    status: { type: String, enum: ['available', 'low_stock', 'out_of_stock', 'maintenance', 'retired'], default: 'available' },
    imageUrl: { type: String, maxlength: 500, trim: true },
    specifications: { type: Object },
    maintenanceSchedule: { type: String, maxlength: 1000, trim: true },
    lastMaintenanceDate: { type: Date },
    nextMaintenanceDate: { type: Date },
    checkouts: [checkoutSchema],
    stockMovements: { type: [stockMovementSchema], default: [] },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

equipmentSchema.index({ categoryId: 1, status: 1 });

equipmentSchema.pre('validate', function assignQrCodeId(next) {
  if (!this.qrCodeId) this.qrCodeId = `NB-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
  next();
});

module.exports = mongoose.model('Equipment', equipmentSchema);


