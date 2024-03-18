const mongoose = require('mongoose');

const contaSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  tipo: { type: String, enum: ['CARTEIRA', 'BANCO', 'INVESTIMENTO'] },
  banco: { type: String },
  conta: { type: String },
  agencia: { type: String },
  ativo: { type: Boolean, default: true },
  titular: { type: mongoose.Schema.Types.ObjectId, ref: 'Agente', required: true }
});

module.exports = mongoose.model('Conta', contaSchema);