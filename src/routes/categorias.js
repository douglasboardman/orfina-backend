const express = require('express');
const router = express.Router();
const categoriasController = require('../controllers/categoriasController');
const { protegerRota } = require('../middlewares/authMiddleware');

router.use(protegerRota)

router.get('/:id', categoriasController.retornarCategoria);
router.get('/listar', categoriasController.listarCategorias);
router.get('/listarPorTipo/:tipo', categoriasController.listarCategoriasPorTipo);
router.post('/', categoriasController.criarCategoria);
router.put('/:id', categoriasController.editarCategoria);
router.delete('/:id', categoriasController.excluirCategoria);

module.exports = router;
