const mongoose = require('mongoose');
const Equipment = require('../../src/models/Equipment');
const ComponentRequest = require('../../src/models/ComponentRequest');

describe('inventory model invariants', () => {
  it('generates a non-guessable stable QR identifier for equipment', async () => {
    const item = new Equipment({
      name: 'ESP32 board',
      categoryId: new mongoose.Types.ObjectId(),
      currentQuantity: 4,
    });

    await item.validate();

    expect(item.qrCodeId).toMatch(/^NB-[A-F0-9]{24}$/);
    const original = item.qrCodeId;
    item.name = 'ESP32 development board';
    await item.validate();
    expect(item.qrCodeId).toBe(original);
  });

  it('validates integer stock movement deltas and requires an audit reason', async () => {
    const item = new Equipment({
      name: 'Servo',
      categoryId: new mongoose.Types.ObjectId(),
      stockMovements: [{
        delta: -2,
        reason: 'Approved request',
        performedBy: new mongoose.Types.ObjectId(),
        type: 'request_approval',
      }],
    });

    await expect(item.validate()).resolves.toBeUndefined();
  });

  it('allows a component request without preassigning a project', async () => {
    const request = new ComponentRequest({
      requesterId: new mongoose.Types.ObjectId(),
      componentName: 'Ultrasonic sensor',
      quantity: 2,
      purpose: 'Prototype testing',
    });

    await expect(request.validate()).resolves.toBeUndefined();
    expect(request.projectId).toBeNull();
  });

  it('rejects fractional component request quantities', async () => {
    const request = new ComponentRequest({
      requesterId: new mongoose.Types.ObjectId(),
      componentName: 'Ultrasonic sensor',
      quantity: 1.5,
      purpose: 'Prototype testing',
    });

    await expect(request.validate()).rejects.toThrow();
  });
});
