import {
	DataTypes,
	type Model,
	type ModelStatic,
	type Sequelize,
} from "sequelize";

export interface UserAttributes {
	id: number;
	asn: number;
	telegramId: number | null;
	person: string | null;
	isAdmin: boolean;
	isBlocked: boolean;
	createdAt?: Date;
	updatedAt?: Date;
}

export type UsersModel = ModelStatic<Model<UserAttributes>>;

export function initUsersModel(sequelize: Sequelize): UsersModel {
	return sequelize.define(
		"users",
		{
			id: {
				type: DataTypes.INTEGER,
				primaryKey: true,
				autoIncrement: true,
			},
			asn: {
				type: DataTypes.INTEGER.UNSIGNED,
				allowNull: false,
				unique: true,
			},
			telegramId: {
				field: "telegram_id",
				type: DataTypes.BIGINT,
				allowNull: true,
				unique: true,
			},
			person: {
				type: DataTypes.STRING,
				allowNull: true,
			},
			isAdmin: {
				field: "is_admin",
				type: DataTypes.BOOLEAN,
				allowNull: false,
				defaultValue: false,
			},
			isBlocked: {
				field: "is_blocked",
				type: DataTypes.BOOLEAN,
				allowNull: false,
				defaultValue: false,
			},
		},
		{
			timestamps: true,
			createdAt: "created_at",
			updatedAt: "updated_at",
			indexes: [{ unique: true, fields: ["asn"] }, { fields: ["telegram_id"] }],
		},
	);
}
