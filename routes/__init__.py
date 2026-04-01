"""
Blueprint registration — imports all route modules and registers them on the app.
"""

from routes.auth_routes import bp as auth_bp
from routes.room_routes import bp as room_bp
from routes.folder_routes import bp as folder_bp
from routes.class_routes import bp as class_bp
from routes.image_routes import bp as image_bp
from routes.edit_routes import bp as edit_bp
from routes.stats_routes import bp as stats_bp
from routes.export_routes import bp as export_bp
from routes.chat_routes import bp as chat_bp
from routes.training_routes import bp as training_bp
from routes.assignment_routes import bp as assignment_bp
from routes.batch_routes import bp as batch_bp
from routes.inference_routes import bp as inference_bp
from routes.model_routes import bp as model_bp


def register_blueprints(app):
    app.register_blueprint(auth_bp)
    app.register_blueprint(room_bp)
    app.register_blueprint(folder_bp)
    app.register_blueprint(class_bp)
    app.register_blueprint(image_bp)
    app.register_blueprint(edit_bp)
    app.register_blueprint(stats_bp)
    app.register_blueprint(export_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(training_bp)
    app.register_blueprint(assignment_bp)
    app.register_blueprint(batch_bp)
    app.register_blueprint(inference_bp)
    app.register_blueprint(model_bp)
