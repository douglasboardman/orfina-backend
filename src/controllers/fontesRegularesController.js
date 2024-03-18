const FonteRegular = require('../models/fonteRegularModel');

exports.retornarFonteRegular = async (req, res) => {
  try {
    const {id} = req.params;
    const fonteRegular = await FonteRegular.findById(id);
    res.json(fonteRegular);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarFontesRegulares = async (req, res) => {
  try {
    const fontesRegulares = await FonteRegular.find().populate(['agente_pagador', 'conta_destino', 'descritivo']);
    res.json(fontesRegulares);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarFontesRegularesPorAgentePagador = async (req, res) => {
  const { agenteId } = req.params;

  try {
    const fontesRegulares = await FonteRegular.find({ agente_pagador: agenteId }).populate(['agente_pagador', 'conta_destino', 'descritivo']);
    res.json(fontesRegulares);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarFontesRegularesPorContaDestino = async (req, res) => {
  const { contaId } = req.params;

  try {
    const fontesRegulares = await FonteRegular.find({ conta_destino: contaId }).populate(['agente_pagador', 'conta_destino', 'descritivo']);
    res.json(fontesRegulares);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarFontesRegularesPorDescritivo = async (req, res) => {
  const { descritivoId } = req.params;

  try {
    const fontesRegulares = await FonteRegular.find({ descritivo: descritivoId }).populate(['agente_pagador', 'conta_destino', 'descritivo']);
    res.json(fontesRegulares);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.criarFonteRegular = async (req, res) => {
  const fonteRegular = new FonteRegular({
    descricao: req.body.descricao,
    valor_base: req.body.valor_base,
    data_base: req.body.data_base,
    validade: req.body.validade,
    ativo: req.body.ativo || true,
    agente_pagador: req.body.agente_pagador,
    conta_destino: req.body.conta_destino,
    descritivo: req.body.descritivo
  });

  try {
    const novaFonteRegular = await fonteRegular.save();
    res.status(201).json(novaFonteRegular);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.editarFonteRegular = async (req, res) => {
  const { id } = req.params;

  try {
    const fonteRegular = await FonteRegular.findByIdAndUpdate(id, req.body, { new: true }).populate(['agente_pagador', 'conta_destino', 'descritivo']);
    res.json(fonteRegular);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.excluirFonteRegular = async (req, res) => {
  const { id } = req.params;

  try {
    await FonteRegular.findByIdAndDelete(id);
    res.json({ message: 'Fonte regular excluída com sucesso.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};