const mongoose = require('mongoose');

const fonteRegularSchema = new mongoose.Schema({
  descricao: { type: String, required: true },
  valor_base: { type: Number, required: true },
  data_base: { type: Date, required: true },
  validade: { type: Date },
  ativo: { type: Boolean, default: true },
  agente_pagador: { type: mongoose.Schema.Types.ObjectId, ref: 'Agente', required: true },
  conta_destino: { type: mongoose.Schema.Types.ObjectId, ref: 'Conta', required: true },
  descritivo: { type: mongoose.Schema.Types.ObjectId, ref: 'Descritivo', required: true }
});

module.exports = mongoose.model('FonteRegular', fonteRegularSchema);