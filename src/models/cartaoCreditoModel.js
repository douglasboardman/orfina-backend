const mongoose = require('mongoose');

const cartaoCreditoSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  titular: { type: mongoose.Schema.Types.ObjectId, ref: 'Agente', required: true },
  bandeira: { type: String, required: true },
  operadora: { type: String, required: true },
  numero: { type: String, required: true, unique: true },
  validade: { type: Date, required: true },
  ativo: { type: Boolean, required: true, default: true }
});

module.exports = mongoose.model('CartaoCredito', cartaoCreditoSchema);
