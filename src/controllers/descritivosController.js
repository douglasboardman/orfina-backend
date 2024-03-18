const Descritivo = require('../models/descritivoModel');

exports.retornarDescritivo = async (req, res) => {
  try {
    const {id} = req.params;
    const descritivo = await Descritivo.findById(id);
    res.json(descritivo);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarDescritivos = async (req, res) => {
  try {
    const descritivos = await Descritivo.find().populate('categoria');
    res.json(descritivos);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarDescritivosPorCategoria = async (req, res) => {
  const { categoriaId } = req.params;

  try {
    const descritivos = await Descritivo.find({ categoria: categoriaId });
    res.json(descritivos);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.criarDescritivo = async (req, res) => {
  const descritivo = new Descritivo({
    categoria: req.body.categoria,
    descritivo: req.body.descritivo
  });

  try {
    const novoDescritivo = await descritivo.save();
    res.status(201).json(novoDescritivo);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.editarDescritivo = async (req, res) => {
  const { id } = req.params;

  try {
    const descritivo = await Descritivo.findByIdAndUpdate(id, req.body, { new: true });
    res.json(descritivo);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.excluirDescritivo = async (req, res) => {
  const { id } = req.params;

  try {
    await Descritivo.findByIdAndDelete(id);
    res.json({ message: 'Descritivo excluído com sucesso.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
