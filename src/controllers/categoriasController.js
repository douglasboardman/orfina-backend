const Categoria = require('../models/categoriaModel');

exports.retornarCategoria = async (req, res) => {
  try{
    const {id} = req.params;
    const categoria = await Categoria.findById(id);
    res.json(categoria);
  } catch(error) {
    res.status(500).json({ message: error.message });
  }
}

exports.listarCategorias = async (req, res) => {
  try {
    const categorias = await Categoria.find();
    res.json(categorias);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.listarCategoriasPorTipo = async (req, res) => {
  const tipo = req.params.tipo.toUpperCase(); // Converte para maiúsculas
  try {
    const categorias = await Categoria.find({ tipo });
    res.json(categorias);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.criarCategoria = async (req, res) => {
  const categoria = new Categoria({
    tipo: req.body.tipo,
    descricao: req.body.descricao
  });

  try {
    const novaCategoria = await categoria.save();
    res.status(201).json(novaCategoria);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.editarCategoria = async (req, res) => {
  const { id } = req.params;

  try {
    const categoria = await Categoria.findByIdAndUpdate(id, req.body, { new: true });
    res.json(categoria);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.excluirCategoria = async (req, res) => {
  const { id } = req.params;

  try {
    await Categoria.findByIdAndDelete(id);
    res.json({ message: 'Categoria excluída com sucesso.' });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
