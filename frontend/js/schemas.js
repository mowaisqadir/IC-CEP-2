// frontend/js/schemas.js
// Config-driven field definitions per record type (soil, water, wildlife).
// See PROJECT_CONTEXT.md §2.4.
// The record form and detail view are generated purely from this config.

export const RECORD_TYPES = [
  { key: 'soil',     label: 'Soil',     icon: '🌱' },
  { key: 'water',    label: 'Water',    icon: '💧' },
  { key: 'wildlife', label: 'Wildlife', icon: '🦉' },
];

const COMMON_FIELDS = [
  {
    key:         'notes',
    label:       'Field Notes',
    type:        'textarea',
    unit:        null,
    min:         null,
    max:         null,
    required:    false,
    placeholder: 'Optional observations, weather, context…',
  },
];

export const SCHEMAS = {
  soil: [
    {
      key:         'site_name',
      label:       'Site Name',
      type:        'text',
      unit:        null,
      min:         null,
      max:         null,
      required:    true,
      placeholder: 'e.g. Plot A-12',
    },
    {
      key:      'ph',
      label:    'Soil pH',
      type:     'number',
      unit:     'pH',
      min:      0,
      max:      14,
      step:     0.1,
      required: false,
    },
    {
      key:      'moisture_pct',
      label:    'Moisture',
      type:     'number',
      unit:     '%',
      min:      0,
      max:      100,
      step:     0.1,
      required: false,
    },
    {
      key:      'temperature_c',
      label:    'Temperature',
      type:     'number',
      unit:     '°C',
      min:      -50,
      max:      70,
      step:     0.1,
      required: false,
    },
    {
      key:      'depth_cm',
      label:    'Sample Depth',
      type:     'number',
      unit:     'cm',
      min:      0,
      max:      1000,
      step:     1,
      required: false,
    },
    {
      key:      'texture',
      label:    'Texture',
      type:     'select',
      unit:     null,
      min:      null,
      max:      null,
      required: false,
      options:  ['sand', 'silt', 'clay', 'loam'],
    },
    {
      key:         'colour',
      label:       'Colour',
      type:        'text',
      unit:        null,
      min:         null,
      max:         null,
      required:    false,
      placeholder: 'e.g. dark brown',
    },
  ],

  water: [
    {
      key:      'source',
      label:    'Water Source',
      type:     'select',
      unit:     null,
      min:      null,
      max:      null,
      required: true,
      options:  ['river', 'lake', 'stream', 'wetland', 'groundwater', 'estuary', 'other'],
    },
    {
      key:      'ph',
      label:    'Water pH',
      type:     'number',
      unit:     'pH',
      min:      0,
      max:      14,
      step:     0.1,
      required: false,
    },
    {
      key:      'turbidity_ntu',
      label:    'Turbidity',
      type:     'number',
      unit:     'NTU',
      min:      0,
      max:      10000,
      step:     0.1,
      required: false,
    },
    {
      key:      'temperature_c',
      label:    'Temperature',
      type:     'number',
      unit:     '°C',
      min:      -10,
      max:      60,
      step:     0.1,
      required: false,
    },
    {
      key:      'dissolved_oxygen_mgl',
      label:    'Dissolved Oxygen',
      type:     'number',
      unit:     'mg/L',
      min:      0,
      max:      30,
      step:     0.1,
      required: false,
    },
    {
      key:      'conductivity',
      label:    'Conductivity',
      type:     'number',
      unit:     'µS/cm',
      min:      0,
      max:      100000,
      step:     1,
      required: false,
    },
  ],

  wildlife: [
    {
      key:         'species',
      label:       'Species',
      type:        'text',
      unit:        null,
      min:         null,
      max:         null,
      required:    true,
      placeholder: 'e.g. Red Fox (Vulpes vulpes)',
    },
    {
      key:      'count',
      label:    'Count',
      type:     'number',
      unit:     'ind.',
      min:      0,
      max:      1000000,
      step:     1,
      required: true,
    },
    {
      key:      'behaviour',
      label:    'Behaviour',
      type:     'select',
      unit:     null,
      min:      null,
      max:      null,
      required: false,
      options:  ['foraging', 'resting', 'moving', 'nesting', 'calling', 'other'],
    },
    {
      key:         'habitat',
      label:       'Habitat',
      type:        'text',
      unit:        null,
      min:         null,
      max:         null,
      required:    false,
      placeholder: 'e.g. riparian woodland',
    },
    {
      key:      'age_class',
      label:    'Age Class',
      type:     'select',
      unit:     null,
      min:      null,
      max:      null,
      required: false,
      options:  ['juvenile', 'subadult', 'adult', 'mixed', 'unknown'],
    },
  ],
};

/**
 * Return the full ordered field list for a record type (type-specific + common).
 * @param {'soil'|'water'|'wildlife'} type
 * @returns {Array<object>}
 */
export function getSchema(type) {
  const fields = SCHEMAS[type];
  if (!fields) {
    throw new Error(`Unknown record type: ${type}`);
  }
  return [...fields, ...COMMON_FIELDS];
}

/**
 * Return metadata for a record type.
 * @param {string} type
 * @returns {{ key: string, label: string, icon: string }}
 */
export function getTypeMeta(type) {
  return RECORD_TYPES.find((t) => t.key === type) || { key: type, label: type, icon: '📋' };
}

/**
 * Validate a record data object against its type schema.
 * Returns { valid: boolean, errors: Record<string, string> }.
 *
 * @param {string}              type
 * @param {Record<string, any>} data
 * @returns {{ valid: boolean, errors: Record<string, string> }}
 */
export function validateRecordData(type, data) {
  const schema = getSchema(type);
  const errors = {};

  for (const field of schema) {
    const raw = data[field.key];
    const isEmpty = raw === undefined || raw === null || raw === '';

    if (field.required && isEmpty) {
      errors[field.key] = `${field.label} is required.`;
      continue;
    }

    if (isEmpty) continue;

    if (field.type === 'number') {
      const num = Number(raw);
      if (Number.isNaN(num)) {
        errors[field.key] = `${field.label} must be a valid number.`;
        continue;
      }
      if (field.min !== null && field.min !== undefined && num < field.min) {
        errors[field.key] = `${field.label} must be at least ${field.min}.`;
      } else if (field.max !== null && field.max !== undefined && num > field.max) {
        errors[field.key] = `${field.label} must be at most ${field.max}.`;
      }
    }

    if (field.type === 'select' && Array.isArray(field.options)) {
      if (!field.options.includes(raw)) {
        errors[field.key] = `Please select a valid ${field.label.toLowerCase()}.`;
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}
