module.exports = (req, res, next) => {
  res.success = ({ data = null, message = "Success", status = 200 } = {}) =>
    res.status(status).json({ success: true, message, data });

  res.error = ({ message = "Something went wrong", status = 500, invalid = undefined } = {}) =>
    res.status(status).json({ success: false, error: true, message, invalid });

  next();
};
