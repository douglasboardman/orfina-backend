const mongoose = require('mongoose');

const agenteSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  tipo: { type: String, required: true, enum: ['PESSOA FÍSICA', 'PESSOA JURÍDICA'] },
  documento: { type: String }
});

module.exports = mongoose.model('Agente', agenteSchema);
