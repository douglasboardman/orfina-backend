const mongoose = require('mongoose');

const lancamentoSchema = new mongoose.Schema({
  tipo: { type: String, required: true },
  descritivo: { type: mongoose.Schema.Types.ObjectId, ref: 'Descritivo', required: true },
  descricao: { type: String },
  cartao_credito: { type: mongoose.Schema.Types.ObjectId, ref: 'CartaoCredito' },
  incidencia: { type: String, required: true },
  parcela_atual: { type: Number },
  total_parcelas: { type: Number },
  conta: { type: mongoose.Schema.Types.ObjectId, ref: 'Conta', required: true },
  data_lancamento: { type: Date, required: true },
  valor: { type: Number, required: true },
});

module.exports = mongoose.model('Lancamento', lancamentoSchema);