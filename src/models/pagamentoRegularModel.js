const mongoose = require('mongoose');

const pagamentoRegularSchema = new mongoose.Schema({
  descricao: { type: String, required: true },
  valor_base: { type: Number, required: true },
  data_base: { type: Date, required: true },
  validade: { type: Date },
  ativo: { type: Boolean, default: true },
  agente_credor: { type: mongoose.Schema.Types.ObjectId, ref: 'Agente', required: true },
  conta_origem: { type: mongoose.Schema.Types.ObjectId, ref: 'Conta', required: true },
  descritivo: { type: mongoose.Schema.Types.ObjectId, ref: 'Descritivo', required: true },
});

module.exports = mongoose.model('PagamentoRegular', pagamentoRegularSchema);