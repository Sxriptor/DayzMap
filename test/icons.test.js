const { test } = require('node:test');
const assert = require('node:assert/strict');
const { eventIcon, sourceIcon } = require('../src/map/loot');

test('vehicle markers match the actual spawn event instead of the shared vehicle layer', () => {
  for (const name of ['VehicleCivilianSedan', 'VehicleHatchback02', 'VehicleOffroad02', 'VehicleOffroadHatchback', 'VehicleSedan02'])
    assert.equal(eventIcon('vehicle', name), 'car', name);
  assert.equal(eventIcon('vehicle', 'VehicleTruck01'), 'truck');
  assert.equal(eventIcon('vehicle', 'VehicleMotorbike'), 'dirtbike');
  assert.equal(eventIcon('policecar', 'StaticPoliceCar'), 'policecar');
  assert.equal(eventIcon('watertruck', 'StaticWaterTruck'), 'truck');
  assert.equal(eventIcon('police', 'Land_PoliceStation'), 'police');
  assert.equal(eventIcon('heli', 'StaticHeliCrash'), 'heli');
  for (const name of ['VehicleBoat', 'VehicleMilitaryBoat', 'VehicleUnknown', undefined])
    assert.equal(eventIcon('vehicle', name), 'unknownVehicle');
});

test('wells use well icons while troughs, cisterns, and fuel sources keep their own icons', () => {
  for (const name of ['Misc_Well_Pump_Blue', 'Misc_Well_Pump_Yellow', 'Land_WaterPump'])
    assert.equal(sourceIcon('water', name), 'well');
  for (const name of ['Misc_Through_Static', 'Wreck_Truck01_Aban2_Cistern_DE', undefined])
    assert.equal(sourceIcon('water', name), 'water');
  assert.equal(sourceIcon('fuel', 'Land_FuelPump'), 'fuel');
});
