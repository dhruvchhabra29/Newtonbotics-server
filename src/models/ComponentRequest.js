const mongoose = require('mongoose');

const auditEntrySchema = new mongoose.Schema({
  action: { type: String, required: true, enum: ['created', 'approved', 'rejected'] },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  performedAt: { type: Date, default: Date.now, required: true },
  changes: { type: mongoose.Schema.Types.Mixed },
  reason: { type: String, maxlength: 2000 },
  ipAddress: { type: String, maxlength: 100 },
  userAgent: { type: String, maxlength: 500 },
}, { _id: false });

const componentRequestSchema = new mongoose.Schema({
  requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', default: null },
  componentName: { type: String, required: true, trim: true, maxlength: 255 },
  quantity: {
    type: Number,
    required: true,
    min: 1,
    validate: { validator: Number.isInteger, message: 'Quantity must be a whole number' },
  },
  approvedQuantity: { type: Number, min: 1, validate: { validator: (value) => value == null || Number.isInteger(value), message: 'Approved quantity must be a whole number' } },
  purpose: { type: String, required: true, trim: true, maxlength: 2000 },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', required: true, index: true },
  reviewerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewNotes: { type: String, trim: true, maxlength: 2000 },
  reviewedAt: { type: Date, default: null },
  auditTrail: { type: [auditEntrySchema], default: [] },
}, { timestamps: true });

componentRequestSchema.index({ requesterId: 1, createdAt: -1 });
componentRequestSchema.index({ status: 1, createdAt: -1 });
componentRequestSchema.index({ projectId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ComponentRequest', componentRequestSchema);